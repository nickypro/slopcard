import SignInWithX from "@/components/SignInWithX";
import LinkSwapcardForm from "@/components/LinkSwapcardForm";
import {
  getCard,
  getSwapcardAttendeeByPersonId,
  listLinkRequestsForHandle,
} from "@/lib/db";
import { getUserSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function LinkPage() {
  const session = await getUserSession();
  const card = session ? getCard(session.twitterHandle) : null;
  const eventId = process.env.SWAPCARD_EVENT_ID || "eag-london-2026";
  const linkedAttendee =
    card?.swapcardPersonId && card.swapcardEventId
      ? getSwapcardAttendeeByPersonId(card.swapcardEventId, card.swapcardPersonId)
      : null;
  // Manual-mode visibility: show "pending admin approval" or
  // "your last request was rejected" so users aren't stuck guessing whether
  // their submission queued. Only surfaces when SWAPCARD_REQUIRE_APPROVAL=1
  // is in play — the queue stays empty otherwise.
  const recentRequests = session
    ? listLinkRequestsForHandle(session.twitterHandle, 5)
    : [];
  const pendingRequest = recentRequests.find((r) => r.state === "pending");
  // Only surface a rejection if it's the user's most recent request — once
  // they re-submit (creating a fresh pending row) the rejection is irrelevant.
  const lastRejected =
    !pendingRequest &&
    recentRequests[0]?.state === "rejected"
      ? recentRequests[0]
      : null;

  return (
    <main className="container">
      <p style={{ marginBottom: "1rem" }}>
        <a href="/" className="muted" style={{ fontSize: "0.9rem" }}>
          ← back
        </a>
      </p>
      <h1 className="title">link your Swapcard profile</h1>
      <p className="subtitle">
        proves you&apos;re actually at the conference so you can use /discover.
        only verified attendees can see attendee data.
      </p>

      <SignInWithX />

      {!session ? (
        <div className="panel">
          <p>sign in with X first to link a Swapcard profile.</p>
        </div>
      ) : (
        // Link-first flow — we no longer require an existing card. /api/swapcard/link
        // auto-creates a minimal "verified" card for the X handle when this is
        // the user's first action. They can /edit later to customize.
        <div className="panel">
          {card ? (
            <p style={{ marginTop: 0 }}>
              <strong>card:</strong> @{card.handle}
            </p>
          ) : (
            <p style={{ marginTop: 0 }} className="muted">
              we&apos;ll auto-create a card for <strong>@{session.twitterHandle}</strong> when you link.
            </p>
          )}
          {linkedAttendee ? (
            <p className="ok" style={{ marginBottom: 0 }}>
              ✓ linked as{" "}
              <strong>
                {linkedAttendee.firstName} {linkedAttendee.lastName}
              </strong>{" "}
              ({eventId}). you can use{" "}
              <a href="/discover">/discover</a>.
            </p>
          ) : pendingRequest ? (
            <div
              className="panel"
              style={{
                marginBottom: 0,
                marginTop: "0.75rem",
                background: "rgba(241, 196, 15, 0.08)",
                border: "1px solid rgba(241, 196, 15, 0.4)",
              }}
            >
              <p style={{ margin: 0 }}>
                ⏳ <strong>pending admin approval.</strong>
              </p>
              <p
                className="muted"
                style={{ margin: "0.4rem 0 0", fontSize: "0.9rem" }}
              >
                you submitted{" "}
                <strong>{pendingRequest.linkedName || "(unknown)"}</strong>{" "}
                on{" "}
                {new Date(pendingRequest.requestedAt).toLocaleString()}. the
                admin will review shortly — refresh this page to check status.
              </p>
            </div>
          ) : lastRejected ? (
            <div
              className="panel"
              style={{
                marginBottom: 0,
                marginTop: "0.75rem",
                background: "rgba(192, 57, 43, 0.06)",
                border: "1px solid rgba(192, 57, 43, 0.4)",
              }}
            >
              <p style={{ margin: 0 }}>
                ✗ <strong>your last request was rejected.</strong>
              </p>
              <p
                className="muted"
                style={{ margin: "0.4rem 0 0", fontSize: "0.9rem" }}
              >
                ({lastRejected.linkedName || "unknown"}, rejected{" "}
                {lastRejected.decidedAt
                  ? new Date(lastRejected.decidedAt).toLocaleString()
                  : "—"}
                ). you can submit a different URL below if there was a mistake.
              </p>
            </div>
          ) : (
            <p className="muted" style={{ marginBottom: 0 }}>
              not linked yet.
            </p>
          )}
          {pendingRequest ? null : (
            <LinkSwapcardForm
              initialUrl={card?.swapcardUrl ?? ""}
              alreadyLinked={!!linkedAttendee}
            />
          )}
        </div>
      )}
    </main>
  );
}
