import { notFound } from "next/navigation";
import SignInWithX from "@/components/SignInWithX";
import DiscoverView from "@/components/DiscoverView";
import {
  getCard,
  getDiscoverRunById,
  getSwapcardAttendeeByAnyId,
} from "@/lib/db";
import { getUserSession } from "@/lib/session";
import type { Attendee, DiscoverRun } from "@/lib/swapcard/types";

export const dynamic = "force-dynamic";

// Permalink to a single cached discover run. Owners use this to load the
// expensive (~$0.50) LLM run on another device/tab without re-running it.
// Owner-only — anyone else gets a 403 panel that doesn't disclose whose
// run it is. Non-numeric / out-of-range / missing ids return 404.
export default async function DiscoverRunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: idParam } = await params;
  const id = Number(idParam);
  // SQLite INTEGERs are 64-bit but JS Number safe range is the practical
  // ceiling; anything past that or non-finite is a 404 rather than a 500.
  if (!Number.isInteger(id) || id <= 0 || id > Number.MAX_SAFE_INTEGER) {
    notFound();
  }

  const session = await getUserSession();
  if (!session) {
    return (
      <main className="container container--wide">
        <p style={{ marginBottom: "1rem" }}>
          <a href="/" className="muted" style={{ fontSize: "0.9rem" }}>
            ← back
          </a>
        </p>
        <h1 className="title">discover</h1>
        <p className="subtitle">
          LLM-picked people from the EAG attendee sheet. only visible to
          verified attendees.
        </p>
        <SignInWithX />
        <div className="panel">
          <p>sign in with X to view this discover run.</p>
        </div>
      </main>
    );
  }

  const stored = getDiscoverRunById(id);
  if (!stored) notFound();

  // Owner check is case-insensitive — handles are lowercased in cards/runs,
  // but a freshly minted session might carry the original-case handle.
  // iter 19 pen-test: collapse non-owner to notFound() so an enumerator
  // can't distinguish "exists but isn't yours" (403) from "doesn't exist"
  // (404). The notFound() call short-circuits to the Next.js 404 page so
  // the fallback panel below never renders under normal routing.
  if (stored.handle.toLowerCase() !== session.twitterHandle.toLowerCase()) {
    notFound();
  }

  // Tolerate older cached payloads without runId by falling back to the row id.
  let run: DiscoverRun;
  try {
    run = JSON.parse(stored.payloadJson) as DiscoverRun;
  } catch {
    notFound();
  }
  if (!run.runId) run.runId = stored.id;

  // Reconstruct the requester profile from the attendee cache. If the row's
  // been evicted or the card unlinked, render the run anyway with a null
  // profile rather than fail — the picks are still useful.
  let requesterProfile: Attendee | null = null;
  let requesterPersonId: string | null = null;
  const card = getCard(stored.handle);
  if (card?.swapcardPersonId && card.swapcardEventId) {
    requesterPersonId = card.swapcardPersonId;
    const row = getSwapcardAttendeeByAnyId(
      card.swapcardEventId,
      card.swapcardPersonId
    );
    if (row) {
      try {
        requesterProfile = JSON.parse(row.profileJson) as Attendee;
      } catch {
        /* ignore malformed cached profile */
      }
    }
  }

  return (
    <main className="container container--wide">
      <h1 className="title">discover</h1>
      <p className="subtitle">cached run · read-only</p>
      <SignInWithX />
      <DiscoverView
        initialRun={run}
        requesterProfile={requesterProfile}
        requesterPersonId={requesterPersonId}
        needsByok={false}
        hasOpenRouterCookie={false}
        readOnly
      />
    </main>
  );
}
