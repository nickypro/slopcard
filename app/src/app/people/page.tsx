import PeopleInfiniteList from "@/components/PeopleInfiniteList";
import SignInWithX from "@/components/SignInWithX";
import {
  getCard,
  getSheetSignature,
  getSwapcardAttendeeByAnyId,
  listAttendeeInterests,
  searchSwapcardAttendees,
  searchSwapcardAttendeesByCloseness,
  type SwapcardAttendeeSearchResult,
} from "@/lib/db";
import { getUserSession } from "@/lib/session";

export const dynamic = "force-dynamic";

// First page is server-rendered for SEO + back-button stability; the client
// list takes over from there via IntersectionObserver-driven loadMore calls.
const PAGE_SIZE = 50;

interface PageProps {
  // Next 15 makes search params async — they arrive as a Promise resolving
  // to a string/array map. We narrow defensively.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function readParam(
  v: string | string[] | undefined,
  fallback = ""
): string {
  if (Array.isArray(v)) return v[0] ?? fallback;
  return v ?? fallback;
}

type SortMode = "alphabetical" | "closeness";

export default async function PeoplePage({ searchParams }: PageProps) {
  const session = await getUserSession();
  const card = session ? getCard(session.twitterHandle) : null;
  const eventId = process.env.SWAPCARD_EVENT_ID || "eag-london-2026";
  const sheetSig = getSheetSignature(eventId);

  const params = await searchParams;
  const rawQuery = readParam(params.q).trim();
  const causeArea = readParam(params.c).trim();
  const sortParam = readParam(params.sort);
  const sort: SortMode =
    sortParam === "closeness" ? "closeness" : "alphabetical";

  // Auth gates mirror /discover/history exactly — same panels, same order,
  // so the user gets a consistent "sign in → make card → link Swapcard"
  // funnel regardless of which gated page they hit first.
  const gated =
    !session || !card || !card.swapcardPersonId || !sheetSig;

  // Only hit the DB once we know the user is allowed to see results. Keeps
  // the unauthenticated-page response trivial.
  let results: SwapcardAttendeeSearchResult[] = [];
  let total = 0;
  let interests: string[] = [];
  if (!gated) {
    // Closeness sort needs to run server-side across the full filtered set —
    // otherwise the page-by-page client re-sort only ranks within each loaded
    // batch (first 50 alphabetical, then next 50, etc.), which is what users
    // reported as "becomes alphabetical again" after scrolling. Falls back to
    // alphabetical if the requester's row has no embedding for some reason.
    if (sort === "closeness" && card?.swapcardEventId && card.swapcardPersonId) {
      const me = getSwapcardAttendeeByAnyId(
        card.swapcardEventId,
        card.swapcardPersonId
      );
      if (me?.embedding && me.embedding.length > 0) {
        const r = searchSwapcardAttendeesByCloseness(
          eventId,
          rawQuery,
          me.embedding,
          PAGE_SIZE,
          0,
          causeArea || undefined
        );
        results = r.results;
        total = r.total;
      } else {
        const r = searchSwapcardAttendees(
          eventId,
          rawQuery,
          PAGE_SIZE,
          0,
          causeArea || undefined
        );
        results = r.results;
        total = r.total;
      }
    } else {
      const r = searchSwapcardAttendees(
        eventId,
        rawQuery,
        PAGE_SIZE,
        0,
        causeArea || undefined
      );
      results = r.results;
      total = r.total;
    }
    interests = listAttendeeInterests(eventId);
  }

  return (
    <main className="container container--wide">
      <p style={{ marginBottom: "1rem" }}>
        <a href="/discover" className="muted" style={{ fontSize: "0.9rem" }}>
          ← back to /discover
        </a>
      </p>
      <h1 className="title">browse attendees</h1>
      <p className="subtitle">
        search the full EAG attendee list by name, role, company, or
        expertise. only visible to verified attendees.
      </p>

      <SignInWithX />

      {!session ? (
        <div className="panel">
          <p>sign in with X to browse attendees.</p>
        </div>
      ) : !card ? (
        <div className="panel">
          <p>
            you don&apos;t have a slopcard yet —{" "}
            <a href="/submit">make one</a>, then come back.
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
        <>
          {/* GET form so URL stays shareable / bookmarkable. The select
              elements submit alongside the input — auto-submitting on change
              would feel snappier but would also break the back button. */}
          <form
            action="/people"
            method="GET"
            className="panel"
            style={{
              display: "flex",
              gap: "0.5rem",
              marginBottom: "1rem",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <input
              type="text"
              name="q"
              defaultValue={rawQuery}
              placeholder="name, role, company, expertise…"
              autoFocus
              style={{
                flex: 1,
                minWidth: "12rem",
                padding: "0.55rem 0.75rem",
                fontSize: "0.95rem",
              }}
            />
            <select
              name="c"
              defaultValue={causeArea}
              aria-label="filter by cause area"
              style={{ padding: "0.5rem 0.5rem", fontSize: "0.9rem" }}
            >
              <option value="">all cause areas</option>
              {interests.map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </select>
            <select
              name="sort"
              defaultValue={sort}
              aria-label="sort order"
              style={{ padding: "0.5rem 0.5rem", fontSize: "0.9rem" }}
            >
              <option value="alphabetical">alphabetical</option>
              <option value="closeness">vector closeness</option>
            </select>
            <button type="submit" className="btn primary">
              search
            </button>
            {rawQuery || causeArea || sort !== "alphabetical" ? (
              <a href="/people" className="btn ghost">
                clear
              </a>
            ) : null}
          </form>

          <div
            className="muted"
            style={{ fontSize: "0.85rem", marginBottom: "1rem" }}
          >
            {rawQuery ? (
              <>
                {total === 0
                  ? `no matches for "${rawQuery}"`
                  : `${total} result${total === 1 ? "" : "s"} for "${rawQuery}"`}
              </>
            ) : (
              <>browsing {total} attendees</>
            )}
            {causeArea ? <> · cause area: {causeArea}</> : null}
            {sort === "closeness" ? (
              <> · sorted by vector closeness (loaded rows only)</>
            ) : null}
          </div>

          <PeopleInfiniteList
            initialResults={results}
            initialTotal={total}
            query={rawQuery}
            causeArea={causeArea}
            sort={sort}
          />
        </>
      )}
    </main>
  );
}
