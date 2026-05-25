import { NextResponse } from "next/server";
import { deleteCard, getCard } from "@/lib/db";
import { getUserSession } from "@/lib/session";
import { siteUrl } from "@/lib/urls";

export const dynamic = "force-dynamic";

export async function POST() {
  const session = await getUserSession();
  if (!session) {
    return NextResponse.redirect(siteUrl("/submit"));
  }
  const card = getCard(session.twitterHandle);
  if (!card) {
    return NextResponse.redirect(siteUrl("/"));
  }
  // Only the verified owner can self-delete. If the card was created
  // anonymously (no verified_twitter_id), the verified user matching by
  // handle is allowed to "claim and delete" — but only if the handle matches.
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
  deleteCard(card.handle, `verified:${session.twitterId}`);
  return NextResponse.redirect(siteUrl("/"));
}
