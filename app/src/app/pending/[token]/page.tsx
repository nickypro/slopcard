import { notFound } from "next/navigation";
import SlopCard from "@/components/SlopCard";
import { getCardByToken } from "@/lib/db";

interface Props {
  params: Promise<{ token: string }>;
}

export default async function PendingPreview({ params }: Props) {
  const { token } = await params;
  const card = getCardByToken(token);
  if (!card) notFound();

  return (
    <main className="container">
      <h1 className="title">your submission</h1>
      <p className="subtitle">
        <span className={`tag ${card.status}`}>{card.status}</span>{" "}
        {card.status === "approved"
          ? `live at /${card.handle}`
          : "awaiting manual review"}
      </p>
      <div className="card-wrap">
        <SlopCard card={card} />
      </div>
      {card.status === "approved" ? (
        <div className="actions" style={{ justifyContent: "center" }}>
          <a className="btn" href={`/${card.handle}/card`}>
            view public card
          </a>
        </div>
      ) : (
        <p className="muted" style={{ textAlign: "center" }}>
          bookmark this URL — it&apos;s how you check back. it&apos;s also the
          only way to view your card until it&apos;s approved.
        </p>
      )}
    </main>
  );
}
