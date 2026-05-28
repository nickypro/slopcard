import { NextRequest, NextResponse } from "next/server";
import {
  getCard,
  setAccentColor,
  setListed,
  updateCardFields,
} from "@/lib/db";
import { getUserSession } from "@/lib/session";
import { extractAccentColor } from "@/lib/color";
import { isValidSwapcardUrl, normalizeBio } from "@/lib/handle";
import { siteUrl } from "@/lib/urls";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await getUserSession();
  if (!session) {
    return NextResponse.redirect(siteUrl("/submit"));
  }
  const handle = session.twitterHandle;
  const card = getCard(handle);
  if (!card) {
    return NextResponse.redirect(
      siteUrl("/edit?error=" + encodeURIComponent("no card to edit"))
    );
  }
  // Belt-and-braces: only the verified owner of the card can edit.
  if (
    card.verifiedTwitterId &&
    card.verifiedTwitterId !== session.twitterId
  ) {
    return NextResponse.redirect(
      siteUrl(
        "/edit?error=" +
          encodeURIComponent("this handle is linked to a different X user")
      )
    );
  }

  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.redirect(
      siteUrl("/edit?error=" + encodeURIComponent("invalid form"))
    );
  }

  const displayName = String(form.get("displayName") || "").slice(0, 80);
  const description = normalizeBio(String(form.get("description") || "")).slice(
    0,
    280
  );
  const avatarUrl = String(form.get("avatarUrl") || "").slice(0, 500);
  const swapcardUrl = String(form.get("swapcardUrl") || "").trim();
  const listed = form.get("listed") === "on";

  if (!isValidSwapcardUrl(swapcardUrl)) {
    return NextResponse.redirect(
      siteUrl("/edit?error=" + encodeURIComponent("invalid swapcard url"))
    );
  }

  const actor = `verified:${session.twitterId}`;
  updateCardFields(
    handle,
    { displayName, description, avatarUrl, swapcardUrl },
    actor
  );
  setListed(handle, listed);

  if (avatarUrl && avatarUrl !== card.avatarUrl) {
    const accent = await extractAccentColor(avatarUrl).catch(() => null);
    if (accent) setAccentColor(handle, accent.hex, accent.darkHex);
  }

  return NextResponse.redirect(siteUrl("/edit?saved=1"));
}
