import { NextRequest, NextResponse } from "next/server";
import { createPendingCard, getCard, setAccentColor } from "@/lib/db";
import {
  isValidHandle,
  isValidSwapcardUrl,
  normalizeHandle,
} from "@/lib/handle";
import { extractAccentColor } from "@/lib/color";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const handle = normalizeHandle(String(body.handle || ""));
  if (!isValidHandle(handle)) {
    return NextResponse.json(
      { error: "invalid handle (1–15 chars, A–Z 0–9 _ only, not reserved)" },
      { status: 400 }
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

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    null;

  const card = createPendingCard({
    handle,
    displayName,
    description,
    avatarUrl,
    swapcardUrl,
    submitterIp: ip,
  });

  // Best-effort: extract accent color from avatar. Failures are silent.
  if (avatarUrl) {
    const accent = await extractAccentColor(avatarUrl).catch(() => null);
    if (accent) setAccentColor(card.handle, accent.hex, accent.darkHex);
  }

  return NextResponse.json({
    handle: card.handle,
    token: card.previewToken,
  });
}
