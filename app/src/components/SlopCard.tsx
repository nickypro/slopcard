import type { Card } from "@/lib/db";

interface Props {
  card: Card;
}

export default function SlopCard({ card }: Props) {
  const avatar =
    card.avatarUrl || `https://unavatar.io/twitter/${card.handle}`;
  return (
    <div className="slopcard">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="slopcard__avatar" src={avatar} alt="" />
      <h2 className="slopcard__name">
        {card.displayName || `@${card.handle}`}
      </h2>
      <p className="slopcard__handle">@{card.handle}</p>
      <p className="slopcard__bio">{card.description}</p>
      <div className="slopcard__footer">
        slopcard.org / {card.handle}
      </div>
    </div>
  );
}
