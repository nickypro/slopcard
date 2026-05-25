import SlopCard from "@/components/SlopCard";
import { listListedApprovedCards } from "@/lib/db";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const cards = listListedApprovedCards();

  return (
    <main className="container container--wide">
      <header className="dashboard-header">
        <div>
          <h1 className="title">slopcard</h1>
          <p className="subtitle">
            little cards for twitter people, linking out to their swapcard.
            {cards.length > 0 ? ` ${cards.length} so far.` : ""}
          </p>
        </div>
        <a className="btn primary" href="/submit">
          submit your own →
        </a>
      </header>

      {cards.length === 0 ? (
        <div className="panel" style={{ textAlign: "center" }}>
          <p className="muted" style={{ margin: 0 }}>
            no cards yet. be the first —{" "}
            <a href="/submit">make a slopcard</a>.
          </p>
        </div>
      ) : (
        <div className="card-grid">
          {cards.map((c) => (
            <div key={c.handle} className="card-grid__item">
              <SlopCard card={c} />
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
