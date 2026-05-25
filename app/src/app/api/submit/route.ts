import { NextRequest, NextResponse } from "next/server";
import {
  createPendingCard,
  createVerifiedApprovedCard,
  getCard,
  setAccentColor,
} from "@/lib/db";
import {
  isValidHandle,
  isValidSwapcardUrl,
  normalizeHandle,
} from "@/lib/handle";
import { extractAccentColor } from "@/lib/color";
import { getUserSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const session = await getUserSession();
  const handle = normalizeHandle(String(body.handle || ""));

  if (!isValidHandle(handle)) {
    return NextResponse.json(
      { error: "invalid handle (1–15 chars, A–Z 0–9 _ only, not reserved)" },
      { status: 400 }
    );
  }

  // If the user is signed in via X, the submitted handle must match the
  // verified one. Stops drive-by squatting using the verified bypass.
  const isVerifiedForHandle =
    session?.twitterHandle.toLowerCase() === handle.toLowerCase();
  if (session && !isVerifiedForHandle) {
    return NextResponse.json(
      {
        error: `you're signed in as @${session.twitterHandle}; you can only submit your own handle. sign out to submit someone else's.`,
      },
      { status: 403 }
    );
  }

  const swapcardUrl = String(body.swapcardUrl || "").trim();
  if (!isValidSwapcardUrl(swapcardUrl)) {
    return NextResponse.json(
      { error: "invalid swapcard url" },
      { status: 400 }
    );
  }

  if (getCard(handle)) {
    return NextResponse.json(
      { error: `@${handle} is already taken (pending or approved)` },
      { status: 409 }
    );
  }

  const displayName = String(body.displayName || "").slice(0, 80);
  const description = String(body.description || "").slice(0, 280);
  const avatarUrl = String(body.avatarUrl || "").slice(0, 500);
  // listed defaults to true; only false if explicitly opted out.
  const listed = body.listed === false ? false : true;

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    null;

  const card = isVerifiedForHandle && session
    ? createVerifiedApprovedCard({
        handle,
        displayName,
        description,
        avatarUrl,
        swapcardUrl,
        submitterIp: ip,
        listed,
        twitterId: session.twitterId,
      })
    : createPendingCard({
        handle,
        displayName,
        description,
        avatarUrl,
        swapcardUrl,
        submitterIp: ip,
        listed,
      });

  if (avatarUrl) {
    const accent = await extractAccentColor(avatarUrl).catch(() => null);
    if (accent) setAccentColor(card.handle, accent.hex, accent.darkHex);
  }

  return NextResponse.json({
    handle: card.handle,
    token: card.previewToken,
    autoApproved: card.status === "approved",
  });
}
