import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { getCard, getSwapcardAttendeePhotoUrl } from "@/lib/db";
import { getUserSession } from "@/lib/session";
import {
  cachePathFor,
  defaultCacheDir,
  sanitizePersonId,
} from "@/lib/swapcard/photo-cache";
import { claimPhotoFetch } from "@/lib/swapcard/rate-limit";

export const dynamic = "force-dynamic";

// Server-side photo proxy + cache. The discover UI hot-linked img.swapcard.com
// (their resizer wrapping the original CDN URL), but Swapcard rotates those
// CDN URLs so cached recommendation runs render broken avatars after a few
// days. This route looks up the photo_url stored at scrape time, fetches the
// bytes ONCE, persists them to <DATA_DIR>/photos, and serves from disk on
// every subsequent hit. The `w` query param is accepted as a hint from the
// client but ignored for now — we serve the original bytes.
//
// Auth: session + linked-attendee. An authenticated-but-unlinked user can't
// enumerate the attendee photo set or spam disk via cache-miss writes (iter
// 19 pen-test). Per-handle rate limit on cache-miss fetches is checked
// AFTER the cache-hit fast path so warm hits stay free.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ personId: string }> }
) {
  const session = await getUserSession();
  if (!session) {
    return NextResponse.json({ error: "sign in with X first" }, { status: 401 });
  }
  const card = getCard(session.twitterHandle);
  if (!card || !card.swapcardPersonId) {
    return NextResponse.json(
      { error: "link your Swapcard profile first" },
      { status: 403 }
    );
  }

  const { personId } = await params;
  const eventId = process.env.SWAPCARD_EVENT_ID || "eag-london-2026";

  const photoUrl = getSwapcardAttendeePhotoUrl(eventId, personId);
  if (!photoUrl) {
    return NextResponse.json({ error: "no photo" }, { status: 404 });
  }

  const cacheDir = defaultCacheDir();
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const filePath = cachePathFor(cacheDir, eventId, personId);

  // Cache hit: serve from disk. Content type isn't persisted alongside the
  // bytes — Swapcard's CDN serves JPEG/WebP/PNG and our consumer is just an
  // <img> tag, so we default to image/jpeg which all browsers happily sniff
  // past if the actual bytes are something else. We send
  // `X-Content-Type-Options: nosniff` (iter 19 pen-test) so a browser will
  // refuse to interpret stored bytes as HTML/JS even if the type is wrong;
  // combined with the upstream content-type validation below this means the
  // disk can't be poisoned with executable content.
  if (existsSync(filePath)) {
    const bytes = readFileSync(filePath);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        // We now cache webp from img.swapcard.com, but browsers happily sniff
        // past the content-type mismatch even on older cached jpeg bytes.
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=86400, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  // Cache miss path: tick the per-handle quota BEFORE upstream fetch so
  // warm hits don't count and a runaway client can't drain disk by asking
  // for fresh ids in a tight loop.
  const claim = claimPhotoFetch(session.twitterHandle);
  if (!claim.allow) {
    return NextResponse.json(
      { error: "too many photo fetches — slow down" },
      {
        status: 429,
        headers: { "Retry-After": String(claim.retryAfterSec) },
      }
    );
  }

  // Cache miss: fetch a SMALL pre-resized version from Swapcard's img.swapcard
  // resizer instead of the original static.swapcard URL. Originals can be
  // multi-megabyte; we only render at 36–64px so 192px webp is plenty and
  // cuts most avatars to <10kB. The original URL is preserved in the DB so
  // we can re-derive higher resolutions later if we want.
  const resizedUrl = `https://img.swapcard.com/?o=webp&u=${encodeURIComponent(
    photoUrl
  )}&q=0.75&m=crop&w=192`;
  let upstream: Response;
  try {
    upstream = await fetch(resizedUrl, {
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "slopcard-photo-cache/1.0" },
    });
  } catch {
    return NextResponse.json({ error: "upstream fetch failed" }, { status: 502 });
  }
  if (!upstream.ok) {
    return NextResponse.json({ error: "upstream fetch failed" }, { status: 502 });
  }
  // Validate (iter 19 pen-test) that what we're about to persist actually
  // claims to be an image. Without this, an upstream redirect to a
  // text/html error page or anything else gets cached on disk and re-served
  // forever from the same cache path. We don't try to sniff the bytes
  // themselves — relying on the upstream type is fine because the response
  // is going behind `X-Content-Type-Options: nosniff` either way.
  const rawContentType = upstream.headers.get("content-type") || "";
  if (!rawContentType.startsWith("image/")) {
    return NextResponse.json(
      { error: "upstream not image" },
      { status: 502 }
    );
  }
  const contentType = rawContentType;
  const buf = Buffer.from(await upstream.arrayBuffer());

  // Atomic write: write to .tmp then rename. PID alone collides if two
  // concurrent requests for the same personId race in the same process,
  // so append 8 random bytes per writer. If the rename loses to another
  // worker (file already there, EEXIST on some platforms or just our
  // unique-tmp loses the race after a concurrent rename), fall back to
  // serving whatever bytes are now at filePath — winner takes all.
  const tmpPath = `${filePath}.tmp.${sanitizePersonId(
    process.pid.toString()
  )}.${crypto.randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(tmpPath, buf);
    try {
      renameSync(tmpPath, filePath);
    } catch {
      // Another writer beat us. If the destination now exists, serve it.
      if (existsSync(filePath)) {
        const winning = readFileSync(filePath);
        return new NextResponse(new Uint8Array(winning), {
          status: 200,
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=86400, immutable",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      return NextResponse.json({ error: "cache write failed" }, { status: 502 });
    }
  } catch {
    return NextResponse.json({ error: "cache write failed" }, { status: 502 });
  }

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
