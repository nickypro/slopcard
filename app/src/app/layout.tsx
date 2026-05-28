import type { Metadata } from "next";
import "./globals.css";

const siteUrl = process.env.SITE_URL || "http://localhost:3000";
const description =
  "a little card for your twitter profile that links to your swapcard. browse the public grid, sign in with X to make your own.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "slopcard",
    template: "%s — slopcard",
  },
  description,
  applicationName: "slopcard",
  authors: [{ name: "slopcard" }],
  keywords: [
    "slopcard",
    "swapcard",
    "twitter card",
    "profile card",
    "tpotmon",
    "x profile",
    "EAG",
    "eag london",
  ],
  openGraph: {
    title: "slopcard",
    description,
    url: siteUrl,
    siteName: "slopcard",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "slopcard",
    description,
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "slopcard",
    url: siteUrl,
    description,
    publisher: {
      "@type": "Organization",
      name: "slopcard",
      url: siteUrl,
      logo: {
        "@type": "ImageObject",
        url: `${siteUrl}/icon.svg`,
      },
    },
  };
  return (
    <html lang="en">
      <body>
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        {children}
      </body>
    </html>
  );
}
