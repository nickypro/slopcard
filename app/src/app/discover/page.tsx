import SignInWithX from "@/components/SignInWithX";
import DiscoverView from "@/components/DiscoverView";
import {
  getCard,
  getLatestDiscoverRun,
  getSheetSignature,
  getSwapcardAttendeeByAnyId,
} from "@/lib/db";
import { getOpenRouterKey, getUserSession } from "@/lib/session";
import { isFreeHandle } from "@/lib/swapcard/byok";
import type { Attendee, DiscoverRun } from "@/lib/swapcard/types";

export const dynamic = "force-dynamic";

export default async function DiscoverPage() {
  const session = await getUserSession();
  const card = session ? getCard(session.twitterHandle) : null;
  const eventId = process.env.SWAPCARD_EVENT_ID || "eag-london-2026";
  const sheetSig = getSheetSignature(eventId);

  // Server-side cache check so the page renders straight into the run if we
  // already have one for the current sheet snapshot. Otherwise the client
  // component shows a "generate" button.
  let initialRun: DiscoverRun | null = null;
  let requesterProfile: Attendee | null = null;
  // We pass the personId (not the raw photo URL) to DiscoverView so its
  // <img> tags route through /api/swapcard/photo/<id>, the server-side
  // cache that insulates us from Swapcard rotating their CDN URLs.
  const requesterPersonId = card?.swapcardPersonId ?? null;
  if (card?.swapcardPersonId && card.swapcardEventId && sheetSig) {
    const stored = getLatestDiscoverRun(card.handle, card.swapcardEventId, sheetSig);
    if (stored) initialRun = JSON.parse(stored.payloadJson) as DiscoverRun;
    const row = getSwapcardAttendeeByAnyId(card.swapcardEventId, card.swapcardPersonId);
    if (row) {
      requesterProfile = JSON.parse(row.profileJson) as Attendee;
    }
  }
  const hasOpenRouterCookie = session ? !!(await getOpenRouterKey()) : false;
  const needsByok = session ? !isFreeHandle(session.twitterHandle) : false;

  return (
    <main className="container container--wide">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: "0.5rem",
          marginBottom: "1rem",
          flexWrap: "wrap",
        }}
      >
        <a href="/" className="muted" style={{ fontSize: "0.9rem" }}>
          ← back
        </a>
        {card?.swapcardPersonId ? (
          <span style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
            <a
              href="/people"
              className="muted"
              style={{ fontSize: "0.9rem" }}
            >
              browse all →
            </a>
            <a
              href="/agenda"
              className="muted"
              style={{ fontSize: "0.9rem" }}
            >
              your agenda →
            </a>
            {/* Always render without a count — the saved set lives in
                localStorage so a server-rendered count would always be
                wrong on first paint and cause a hydration mismatch. */}
            <a
              href="/saved"
              className="muted"
              style={{ fontSize: "0.9rem" }}
            >
              your saved →
            </a>
            <a
              href="/discover/history"
              className="muted"
              style={{ fontSize: "0.9rem" }}
            >
              your history →
            </a>
          </span>
        ) : null}
      </div>
      <h1 className="title">discover</h1>
      <p className="subtitle">
        LLM-picked people from the EAG attendee sheet. only visible to verified
        attendees.
      </p>

      <SignInWithX />

      {!session ? (
        <div className="panel">
          <p>sign in with X to use discover.</p>
        </div>
      ) : !card ? (
        <div className="panel">
          <p>
            you don&apos;t have a slopcard yet — <a href="/submit">make one</a>,
            then come back.
          </p>
        </div>
      ) : !card.swapcardPersonId ? (
        <div className="panel">
          <p>
            link your Swapcard profile to prove you&apos;re at the conference.{" "}
            <a href="/link">go to /link →</a>
          </p>
        </div>
      ) : !sheetSig ? (
        <div className="panel">
          <p>
            the attendee dataset hasn&apos;t been ingested yet on this server.
            ask an admin to run <code>POST /api/swapcard/ingest</code>.
          </p>
        </div>
      ) : (
        <DiscoverView
          initialRun={initialRun}
          requesterProfile={requesterProfile}
          requesterPersonId={requesterPersonId}
          needsByok={needsByok}
          hasOpenRouterCookie={hasOpenRouterCookie}
        />
      )}
    </main>
  );
}
