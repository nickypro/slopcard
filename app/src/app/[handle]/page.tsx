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
    return { title: "not found" };
  }
  const title = card.displayName || `@${card.handle}`;
  const description = card.description || `slopcard for @${card.handle}`;
  const og = {
    url: `/api/og/${card.handle}`,
    width: 1200,
    height: 630,
    type: "image/png",
    alt: `${title} — slopcard`,
  };
  return {
    title,
    description,
    alternates: { canonical: `/${card.handle}` },
    openGraph: {
      title,
      description,
      images: [og],
      url: `/${card.handle}`,
      siteName: "slopcard",
      type: "profile",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [og],
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

  const siteUrl = (process.env.SITE_URL || "https://slopcard.org").replace(
    /\/$/,
    ""
  );
  const personJsonLd = {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    mainEntity: {
      "@type": "Person",
      name: card.displayName || `@${card.handle}`,
      alternateName: `@${card.handle}`,
      description: card.description || undefined,
      image: card.avatarUrl || undefined,
      url: `${siteUrl}/${card.handle}`,
      sameAs: [`https://x.com/${card.handle}`, card.swapcardUrl].filter(Boolean),
    },
  };

  return (
    <main className="container">
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(personJsonLd) }}
      />
      <div className="card-wrap">
        <SlopCard card={card} />
      </div>
      <p style={{ textAlign: "center", marginTop: "1.5rem" }}>
        {isOwner ? (
          <a
            href="/submit"
            className="btn ghost"
            style={{ marginRight: "0.6rem" }}
          >
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
