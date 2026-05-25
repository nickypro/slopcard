import { notFound } from "next/navigation";
import SlopCard from "@/components/SlopCard";
import { getCard } from "@/lib/db";
import { normalizeHandle } from "@/lib/handle";

interface Props {
  params: Promise<{ handle: string }>;
}

export default async function CardView({ params }: Props) {
  const { handle } = await params;
  const card = getCard(normalizeHandle(handle));
  if (!card || card.status !== "approved") notFound();

  return (
    <main className="container">
      <div className="card-wrap">
        <SlopCard card={card} />
      </div>
      <p style={{ textAlign: "center", marginTop: "1.5rem" }}>
        <a href="/submit" className="muted" style={{ fontSize: "0.9rem" }}>
          ← make your own slopcard
        </a>
      </p>
    </main>
  );
}
