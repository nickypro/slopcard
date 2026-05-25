import { notFound } from "next/navigation";
import type { Metadata } from "next";
import SlopCard from "@/components/SlopCard";
import { getCard } from "@/lib/db";
import { normalizeHandle } from "@/lib/handle";
import { getUserSession } from "@/lib/session";

interface Props {
  params: Promise<{ handle: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params;
  const card = getCard(normalizeHandle(handle));
  if (!card || card.status !== "approved") {
    return { title: "slopcard — not found" };
  }
  const title = card.displayName || `@${card.handle}`;
  return {
    title: `${title} — slopcard`,
    description: card.description || `slopcard for @${card.handle}`,
    openGraph: {
      title,
      description: card.description,
      images: [`/api/og/${card.handle}`],
      url: `/${card.handle}`,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: card.description,
      images: [`/api/og/${card.handle}`],
    },
  };
}

export default async function HandleProfile({ params }: Props) {
  const { handle } = await params;
  const card = getCard(normalizeHandle(handle));
  if (!card || card.status !== "approved") notFound();

  const session = await getUserSession();
  const isOwner =
    !!session && session.twitterHandle.toLowerCase() === card.handle;

  return (
    <main className="container">
      <div className="card-wrap">
        <SlopCard card={card} />
      </div>
      <p style={{ textAlign: "center", marginTop: "1.5rem" }}>
        {isOwner ? (
          <a href="/edit" className="btn ghost" style={{ marginRight: "0.6rem" }}>
            ✏ edit my card
          </a>
        ) : null}
        <a href="/submit" className="muted" style={{ fontSize: "0.9rem" }}>
          ← make your own slopcard
        </a>
      </p>
    </main>
  );
}
