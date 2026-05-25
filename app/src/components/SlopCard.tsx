import type { Card } from "@/lib/db";

interface Props {
  card: Card;
  stats?: {
    followers?: number;
    following?: number;
    tweets?: number;
  };
}

function formatStat(n: number | undefined): string {
  if (typeof n !== "number") return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + "k";
  return String(n);
}

export default function SlopCard({ card, stats }: Props) {
  const avatar =
    card.avatarUrl || `https://unavatar.io/twitter/${card.handle}`;
  const showStats =
    stats &&
    (typeof stats.followers === "number" ||
      typeof stats.following === "number" ||
      typeof stats.tweets === "number");

  return (
    <article className="slopcard">
      <header className="slopcard__banner">
        <span>SLOPCARD</span>
        <span>★</span>
        <span>v1</span>
      </header>
      <div className="slopcard__body">
        <span className="slopcard__avatar-ring">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="slopcard__avatar" src={avatar} alt="" />
        </span>
        <h2 className="slopcard__name">
          {card.displayName || `@${card.handle}`}
        </h2>
        <p className="slopcard__handle">{`@${card.handle}`}</p>
        {card.description ? (
          <p className="slopcard__bio">{card.description}</p>
        ) : null}
        {showStats ? (
          <div className="slopcard__stats">
            <div className="slopcard__stat">
              <span className="slopcard__stat-val">
                {formatStat(stats.followers)}
              </span>
              <span className="slopcard__stat-label">Followers</span>
            </div>
            <div className="slopcard__stat">
              <span className="slopcard__stat-val">
                {formatStat(stats.following)}
              </span>
              <span className="slopcard__stat-label">Following</span>
            </div>
            <div className="slopcard__stat">
              <span className="slopcard__stat-val">
                {formatStat(stats.tweets)}
              </span>
              <span className="slopcard__stat-label">Tweets</span>
            </div>
          </div>
        ) : null}
        <a className="slopcard__cta" href={card.swapcardUrl}>
          Open on Swapcard →
        </a>
      </div>
      <footer className="slopcard__footer">
        slopcard.org / {card.handle}
      </footer>
    </article>
  );
}
