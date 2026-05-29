import SavedList from "@/components/SavedList";
import SignInWithX from "@/components/SignInWithX";
import { getCard } from "@/lib/db";
import { getUserSession } from "@/lib/session";

export const dynamic = "force-dynamic";

// The "my conference list" view — bookmarked attendees + how their free
// 30-min slots overlap with the requester's own free slots. Auth-gated the
// same way as /agenda since the overlap math leaks the user's own calendar.
export default async function SavedPage() {
  const session = await getUserSession();
  const card = session ? getCard(session.twitterHandle) : null;

  return (
    <main className="container container--wide">
      <p style={{ marginBottom: "1rem" }}>
        <a href="/discover" className="muted" style={{ fontSize: "0.9rem" }}>
          ← back to /discover
        </a>
      </p>
      <h1 className="title">your saved attendees</h1>
      <p className="subtitle">
        your bookmarked picks across this conference. saves are local to your
        browser.
      </p>

      <SignInWithX />

      {!session ? (
        <div className="panel">
          <p>sign in with X to view your saved attendees.</p>
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
            link your Swapcard profile first.{" "}
            <a href="/link">go to /link →</a>
          </p>
        </div>
      ) : (
        <SavedList />
      )}
    </main>
  );
}
