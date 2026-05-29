import { NextRequest, NextResponse } from "next/server";
import {
  createPendingLinkRequest,
  createVerifiedApprovedCard,
  getCard,
  getSwapcardAttendeeByAnyId,
  linkSwapcardToCard,
  listPendingLinkRequests,
} from "@/lib/db";
import { getUserSession } from "@/lib/session";
import { parseSwapcardUrl } from "@/lib/swapcard/parse-url";
import { sendSignalNotification } from "@/lib/signal";
import { sendAdminSms } from "@/lib/twilio";
import { siteUrl } from "@/lib/urls";

export const dynamic = "force-dynamic";

// Claim a Swapcard attendee URL for the signed-in user's card. Three gates:
// 1. caller must be signed in via X (so the actor is verifiable);
// 2. URL must parse to an EventPeople id (rejects exhibitor/session links);
// 3. that id must exist in the cached attendee dataset for this event.
// Uniqueness is enforced at the DB layer: two slopcard cards can't claim the
// same Swapcard profile.
//
// When SWAPCARD_REQUIRE_APPROVAL=1, the actual link is deferred: we enqueue
// a pending request, SMS the admin, and return {pending:true}. The admin
// flips the env var when they're ready to gate new signups — leaving it
// unset preserves the existing auto-claim flow.
export async function POST(req: NextRequest) {
  const session = await getUserSession();
  if (!session) {
    return NextResponse.json({ error: "sign in with X first" }, { status: 401 });
  }
  const handle = session.twitterHandle;
  let card = getCard(handle);
  // Link-first flow: auto-create a minimal verified card if the user hasn't
  // submitted one yet. The card row is where we hang the swapcard_person_id,
  // so it has to exist — but requiring users to write a bio first was a
  // friction point. They can /edit later if they want to customize.
  if (!card) {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
      req.headers.get("x-real-ip") ||
      null;
    card = createVerifiedApprovedCard(
      {
        handle,
        displayName: "",
        description: "",
        avatarUrl: "",
        swapcardUrl: "",
        submitterIp: ip,
        listed: false,
        twitterId: session.twitterId,
      },
      `verified:${session.twitterId}`
    );
  }

  let body: { swapcardUrl?: unknown };
  try {
    body = (await req.json()) as { swapcardUrl?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const raw = typeof body.swapcardUrl === "string" ? body.swapcardUrl : "";
  const parsed = parseSwapcardUrl(raw);
  if (!parsed) {
    return NextResponse.json(
      {
        error:
          "not a valid Swapcard attendee URL (expected app.swapcard.com/event/<slug>/person/<id>)",
      },
      { status: 400 }
    );
  }
  const personId = parsed.personId;

  const eventId = process.env.SWAPCARD_EVENT_ID || "eag-london-2026";
  // Look up by either ID scheme. The sheet stores CommunityProfile IDs but
  // browser URLs use EventPeople IDs; we resolve to a single record either way.
  const attendee = getSwapcardAttendeeByAnyId(eventId, personId);
  if (!attendee) {
    return NextResponse.json(
      {
        error:
          "that profile isn't in our attendee dataset for this event.",
      },
      { status: 404 }
    );
  }
  // Use the canonical CommunityProfile ID for the link record so all paths
  // (sheet data, discover lookups) refer to the same key.
  const canonicalId = attendee.personId ?? personId;
  const linkedName = `${attendee.firstName} ${attendee.lastName}`.trim();

  // Approval-gated path: enqueue + SMS the admin, return pending. Idempotent
  // via the partial unique index in db.ts — a duplicate POST returns the same
  // requestId and the SMS doesn't re-fire (we detect the pre-existing row by
  // probing the queue before insert).
  if (process.env.SWAPCARD_REQUIRE_APPROVAL === "1") {
    const alreadyPending = listPendingLinkRequests(1000).some(
      (r) => r.handle === handle && r.personId === canonicalId
    );
    const { id, approveToken } = createPendingLinkRequest({
      handle,
      personId: canonicalId,
      eventId,
      linkedName,
    });
    if (!alreadyPending) {
      const approveUrl = siteUrl(`/admin/link-requests/${approveToken}`);
      const notifyBody = `slopcard link request #${id}: @${handle} claiming ${linkedName}. approve: ${approveUrl}`;
      // Best-effort across both channels. Either send may no-op (Twilio when
      // TWILIO_FROM is blank, Signal when SIGNAL_NOTIFICATIONS_ENABLED!=1) —
      // the admin can always see the queue at /admin/link-requests + the
      // banner that surfaces a pending count on every page.
      await sendAdminSms(notifyBody);
      sendSignalNotification(notifyBody).catch(() => {
        /* never throws but defensive in case fetch wrapper changes */
      });
    }
    return NextResponse.json({
      ok: true,
      pending: true,
      requestId: id,
      message:
        "your link request is pending admin approval — you'll get access once it's approved.",
    });
  }

  const actor = `verified:${session.twitterId}`;
  // Detect first-time link vs re-link by checking the card before the call.
  // The owner wants an SMS when a new person finishes signup; re-verifies of
  // an already-linked card shouldn't fire (would be noise after a reload).
  const wasUnlinked = !card.swapcardPersonId;
  const result = linkSwapcardToCard(handle, eventId, canonicalId, actor);
  if (!result.ok) {
    if (result.reason === "already_linked_other") {
      return NextResponse.json(
        { error: "that Swapcard profile is already linked to a different slopcard" },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: "could not link" }, { status: 500 });
  }
  // Signup notification — fire-and-forget across SMS + Signal. Best-effort,
  // never blocks the response if either channel is unreachable. Only on
  // first link to avoid noise on re-verifies / cookie clears.
  if (wasUnlinked) {
    const notifyBody = `slopcard signup: @${handle} → ${linkedName} (${eventId})`;
    sendAdminSms(notifyBody).catch(() => {
      /* SMS is non-critical; the link itself succeeded */
    });
    sendSignalNotification(notifyBody).catch(() => {
      /* same — Signal is non-critical */
    });
  }
  return NextResponse.json({
    ok: true,
    linkedName,
    eventId,
    personId: canonicalId,
  });
}
