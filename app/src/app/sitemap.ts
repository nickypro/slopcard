import type { MetadataRoute } from "next";
import { listListedApprovedCards } from "@/lib/db";

export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = (process.env.SITE_URL || "https://slopcard.org").replace(
    /\/$/,
    ""
  );
  const cards = listListedApprovedCards();
  const now = new Date();

  return [
    {
      url: `${base}/`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 1,
    },
    {
      url: `${base}/submit`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.5,
    },
    ...cards.map((c) => ({
      url: `${base}/${c.handle}`,
      lastModified: new Date(c.updatedAt),
      changeFrequency: "weekly" as const,
      priority: 0.8,
    })),
  ];
}
