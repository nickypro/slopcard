import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { approveCard, setAccentColor } from "@/lib/db";
import { extractAccentColor } from "@/lib/color";
import { siteUrl } from "@/lib/urls";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const form = await req.formData().catch(() => null);
  const handle = String(form?.get("handle") || "");
  if (!handle) {
    return NextResponse.json({ error: "missing handle" }, { status: 400 });
  }
  const card = approveCard(handle, "admin");
  if (!card) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // Best-effort: extract accent from the avatar at approve time. If the
  // extractor returns null (e.g. photo with no saturated dominant hue),
  // accent_color stays NULL and the card uses the default coral palette.
  if (card.avatarUrl && !card.accentColor) {
    const accent = await extractAccentColor(card.avatarUrl).catch(() => null);
    if (accent) setAccentColor(card.handle, accent.hex, accent.darkHex);
  }
  return NextResponse.redirect(siteUrl("/admin"));
}
