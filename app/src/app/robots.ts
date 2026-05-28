import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const base = (process.env.SITE_URL || "https://slopcard.org").replace(
    /\/$/,
    ""
  );
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/admin/", "/api/", "/pending/", "/thanks"],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
