import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getCard } from "@/lib/db";
import { normalizeHandle } from "@/lib/handle";

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

export default async function HandleRedirect({ params }: Props) {
  const { handle } = await params;
  const card = getCard(normalizeHandle(handle));
  if (!card || card.status !== "approved") notFound();

  const target = card.swapcardUrl;
  return (
    <main className="container">
      <p className="muted">redirecting to swapcard…</p>
      <p>
        <a href={target}>{target}</a>
      </p>
      <script
        dangerouslySetInnerHTML={{
          __html: `window.location.replace(${JSON.stringify(target)})`,
        }}
      />
      <noscript>
        <meta httpEquiv="refresh" content={`0; url=${target}`} />
      </noscript>
    </main>
  );
}
