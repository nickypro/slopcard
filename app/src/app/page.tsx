import SignInWithX from "@/components/SignInWithX";
import SlopCard from "@/components/SlopCard";
import { getCard, listListedApprovedCards } from "@/lib/db";
import { getUserSession } from "@/lib/session";

export const dynamic = "force-dynamic";

// State-aware homepage. Three funnel stages, each with one clear primary
// action and a feature grid that opens up once the user is linked.
//   1. anon         → "sign in with X" hero + preview of what's behind the gate
//   2. signed-in    → "link your Swapcard" hero (the actual feature gate)
//   3. linked       → feature dashboard (discover, agenda, saved, browse people)
// The public slopcard grid stays below regardless — it's the "browse" surface,
// independent of personal access.

interface FeatureCard {
  href: string;
  emoji: string;
  title: string;
  desc: string;
}

const FEATURES: FeatureCard[] = [
  {
    href: "/discover",
    emoji: "✨",
    title: "discover",
    desc: "LLM-picked attendees you'd want to meet, ranked + reasoned.",
  },
  {
    href: "/agenda",
    emoji: "📅",
    title: "agenda",
    desc: "the full conference schedule — parallel tracks, add to your calendar.",
  },
  {
    href: "/saved",
    emoji: "★",
    title: "saved",
    desc: "your bookmarked attendees with free-slot overlap against you.",
  },
  {
    href: "/people",
    emoji: "🔍",
    title: "browse people",
    desc: "search all 2300+ attendees by name, role, expertise.",
  },
];

export default async function HomePage() {
  const cards = listListedApprovedCards();
  const session = await getUserSession();
  const myCard = session ? getCard(session.twitterHandle) : null;
  const linked = !!myCard?.swapcardPersonId;

  return (
    <main className="container container--wide">
      <header className="dashboard-header">
        <div>
          <h1 className="title">slopcard</h1>
          <p className="subtitle">
            attendee discovery for EAG London 2026 · sign in with X + link your
            Swapcard to unlock.
          </p>
        </div>
      </header>

      {/* Stage 1 — anonymous: explain the gate, primary CTA = sign in with X */}
      {!session ? (
        <section className="panel" style={{ marginBottom: "1.5rem" }}>
          <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.25rem" }}>
            sign in to get started
          </h2>
          <p className="muted" style={{ marginTop: 0, marginBottom: "1rem" }}>
            slopcard mirrors the EAG attendee sheet behind a verified-attendee
            gate — sign in with X, then paste your Swapcard URL to prove you&apos;re
            here. nothing&apos;s visible to non-attendees.
          </p>
          <SignInWithX />
          <p
            className="muted"
            style={{ fontSize: "0.85rem", marginTop: "1rem", marginBottom: 0 }}
          >
            once you&apos;re in:
          </p>
          <FeaturePreview features={FEATURES} dim />
        </section>
      ) : !linked ? (
        // Stage 2 — signed in but not linked: the linking step is the gate
        <section className="panel" style={{ marginBottom: "1.5rem" }}>
          <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.25rem" }}>
            link your Swapcard
          </h2>
          <p className="muted" style={{ marginTop: 0, marginBottom: "1rem" }}>
            signed in as <strong>@{session.twitterHandle}</strong>. paste your
            Swapcard profile URL to verify you&apos;re at EAG and unlock everything
            below.
          </p>
          <a className="btn primary" href="/link">
            link your Swapcard →
          </a>
          <FeaturePreview features={FEATURES} dim />
        </section>
      ) : (
        // Stage 3 — linked: feature dashboard
        <section style={{ marginBottom: "1.5rem" }}>
          <p
            className="muted"
            style={{ marginTop: 0, marginBottom: "1rem", fontSize: "0.9rem" }}
          >
            ✓ verified @{session.twitterHandle} ·{" "}
            <a href="/link">manage link</a>
          </p>
          <FeatureGrid features={FEATURES} />
        </section>
      )}

      {/* Public card grid — always visible. Card creation is OPTIONAL: linking
          is what unlocks features, the slopcard page itself is just a public
          profile you can opt into. */}
      <section>
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            flexWrap: "wrap",
            gap: "0.5rem",
            marginBottom: "1rem",
          }}
        >
          <h2 style={{ margin: 0, fontSize: "1.2rem", fontWeight: 600 }}>
            public slopcards
            <span
              className="muted"
              style={{ fontSize: "0.85rem", fontWeight: 400, marginLeft: "0.5rem" }}
            >
              ({cards.length})
            </span>
          </h2>
          <a className="btn ghost" href="/submit" style={{ fontSize: "0.85rem" }}>
            {myCard ? "edit / delete your card →" : "make one (optional) →"}
          </a>
        </header>

        {cards.length === 0 ? (
          <div className="panel" style={{ textAlign: "center" }}>
            <p className="muted" style={{ margin: 0 }}>
              no cards yet. <a href="/submit">make the first →</a>
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
      </section>
    </main>
  );
}

function FeatureGrid({ features }: { features: FeatureCard[] }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: "0.75rem",
      }}
    >
      {features.map((f) => (
        <a
          key={f.href}
          href={f.href}
          className="panel"
          style={{
            textDecoration: "none",
            color: "var(--ink)",
            display: "block",
            padding: "1.25rem 1.25rem",
            transition: "transform 0.06s",
          }}
        >
          <div style={{ fontSize: "1.5rem", marginBottom: "0.4rem" }}>
            {f.emoji}
          </div>
          <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>
            {f.title} →
          </div>
          <div className="muted" style={{ fontSize: "0.85rem" }}>
            {f.desc}
          </div>
        </a>
      ))}
    </div>
  );
}

function FeaturePreview({
  features,
  dim,
}: {
  features: FeatureCard[];
  dim: boolean;
}) {
  return (
    <ul
      style={{
        listStyle: "none",
        padding: 0,
        margin: "0.5rem 0 0",
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: "0.5rem",
        opacity: dim ? 0.7 : 1,
      }}
    >
      {features.map((f) => (
        <li
          key={f.href}
          style={{
            fontSize: "0.85rem",
            padding: "0.5rem 0.75rem",
            background: "rgba(0,0,0,0.04)",
            borderRadius: 6,
          }}
        >
          <span style={{ marginRight: "0.4rem" }}>{f.emoji}</span>
          <strong>{f.title}</strong>
          <div className="muted" style={{ fontSize: "0.78rem", marginTop: "0.15rem" }}>
            {f.desc}
          </div>
        </li>
      ))}
    </ul>
  );
}
