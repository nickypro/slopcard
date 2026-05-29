import SignInWithX from "@/components/SignInWithX";
import { getCard, listDiscoverRunsForHandle } from "@/lib/db";
import { getUserSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function DiscoverHistoryPage() {
  const session = await getUserSession();
  const card = session ? getCard(session.twitterHandle) : null;
  const runs = session
    ? listDiscoverRunsForHandle(session.twitterHandle, 50)
    : [];

  return (
    <main className="container">
      <p style={{ marginBottom: "1rem" }}>
        <a href="/discover" className="muted" style={{ fontSize: "0.9rem" }}>
          ← back to /discover
        </a>
      </p>
      <h1 className="title">your discover history</h1>
      <p className="subtitle">
        every LLM-tier run you&apos;ve generated, newest first. click one to
        reopen without re-paying.
      </p>

      <SignInWithX />

      {!session ? (
        <div className="panel">
          <p>sign in with X to view your history.</p>
        </div>
      ) : !card ? (
        <div className="panel">
          <p>
            you don&apos;t have a slopcard yet —{" "}
            <a href="/submit">make one</a>, then come back.
          </p>
        </div>
      ) : runs.length === 0 ? (
        <div className="panel">
          <p>
            no runs yet. <a href="/discover">generate your first one →</a>
          </p>
        </div>
      ) : (
        <div className="panel" style={{ padding: 0 }}>
          {runs.map((r, i) => (
            <a
              key={r.id}
              href={`/discover/run/${r.id}`}
              style={{
                display: "flex",
                gap: "1rem",
                padding: "0.9rem 1rem",
                borderBottom:
                  i < runs.length - 1 ? "1px solid rgba(0,0,0,0.06)" : "none",
                color: "var(--ink)",
                textDecoration: "none",
                alignItems: "baseline",
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  fontFamily: "monospace",
                  fontSize: "0.78rem",
                  minWidth: "5em",
                  color: "var(--ink-2)",
                }}
              >
                #{r.id}
              </span>
              <span style={{ fontSize: "0.9rem", fontWeight: 500 }}>
                {new Date(r.createdAt).toLocaleString()}
              </span>
              <span
                className="muted"
                style={{ fontSize: "0.85rem", flex: 1, minWidth: "10rem" }}
              >
                {r.recommendationCount} picks · {r.totalAttendees} attendees
                scanned · {r.eventId}
              </span>
              <span
                className="muted"
                style={{ fontSize: "0.85rem", flexShrink: 0 }}
              >
                open →
              </span>
            </a>
          ))}
        </div>
      )}
    </main>
  );
}
