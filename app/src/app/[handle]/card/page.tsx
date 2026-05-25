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
      <div className="actions" style={{ justifyContent: "center" }}>
        <a className="btn" href={card.swapcardUrl}>
          open swapcard
        </a>
        <a className="btn ghost" href={`/${card.handle}`}>
          permalink
        </a>
      </div>
    </main>
  );
}
