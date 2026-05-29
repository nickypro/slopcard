import { NextRequest, NextResponse } from "next/server";
import {
  getCard,
  getSwapcardAttendeeByAnyId,
} from "@/lib/db";
import { getUserSession } from "@/lib/session";
import { blobToVector, cosine } from "@/lib/swapcard/embed";
import { claimCheapSlot } from "@/lib/swapcard/rate-limit";

export const dynamic = "force-dynamic";

// Per-page cap. Mirrors /people's PAGE_SIZE — the page only ever asks for
// closeness scores against the rows it currently has on screen.
const MAX_IDS = 50;

// Sort-by-closeness helper for /people. The page POSTs the IDs currently
// rendered; we reuse the requester's cached embedding to score each one with
// cosine similarity and return a plain id→similarity object. Same auth gates
// as /discover-vector (session + linked attendee). Tradeoff: scoring is per-
// page, so users only sort within what they've already loaded — full-list
// sorting would require shipping or holding 2k embeddings in memory per call.
export async function POST(req: NextRequest) {
  const session = await getUserSession();
  if (!session) {
    return NextResponse.json({ error: "sign in with X first" }, { status: 401 });
  }
  const card = getCard(session.twitterHandle);
  if (!card) {
    return NextResponse.json(
      { error: "no card for this handle — submit one first" },
      { status: 404 }
    );
  }
  if (!card.swapcardPersonId || !card.swapcardEventId) {
    return NextResponse.json(
      { error: "link your Swapcard profile first" },
      { status: 412 }
    );
  }

  // Cheap-bucket rate limit (same shape as /discover-vector + /saved-summary).
  const slot = claimCheapSlot({
    handle: session.twitterHandle,
    kind: "closeness",
  });
  if (!slot.allow) {
    return NextResponse.json(
      { error: "slow down — too many requests" },
      {
        status: 429,
        headers: { "Retry-After": String(slot.retryAfterSec) },
      }
    );
  }

  try {
    let body: { ids?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      /* optional body */
    }
    const raw = Array.isArray(body.ids) ? body.ids : [];
    if (raw.length > MAX_IDS) {
      return NextResponse.json(
        { error: `too many ids (max ${MAX_IDS})` },
        { status: 400 }
      );
    }
    const ids: string[] = [];
    for (const v of raw) {
      if (typeof v === "string" && v.length > 0) ids.push(v);
    }

    // Requester's own row carries the embedding we score against. Stub rows
    // (no person_id) have a zero-buffer embedding, in which case cosine
    // collapses to zero for everyone and the client just sees a uniform sort.
    const me = getSwapcardAttendeeByAnyId(
      card.swapcardEventId,
      card.swapcardPersonId
    );
    if (!me) {
      return NextResponse.json(
        { error: "your linked attendee record isn't in the cache" },
        { status: 410 }
      );
    }
    const myVec = blobToVector(me.embedding);

    // Score each requested ID. Missing rows are simply absent from the
    // response map; the client treats absent as "0" and they sort last.
    const similarities: Record<string, number> = {};
    for (const id of ids) {
      const row = getSwapcardAttendeeByAnyId(card.swapcardEventId, id);
      if (!row) continue;
      const v = blobToVector(row.embedding);
      similarities[id] = cosine(myVec, v);
    }

    return NextResponse.json({ ok: true, similarities });
  } finally {
    slot.release();
  }
}
