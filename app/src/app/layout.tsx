import type { Metadata } from "next";
import { headers } from "next/headers";
import { isAdmin } from "@/lib/auth";
import { countPendingLinkRequests } from "@/lib/db";
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

export default async function RootLayout({
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
  // Per-request CSP nonce set by `src/middleware.ts`. Falls back to undefined
  // if the matcher excluded this route (shouldn't happen for HTML routes) so
  // the script still renders — the browser will then block it, which is the
  // correct CSP behaviour rather than rendering a broken page.
  const hdrs = await headers();
  const nonce = hdrs.get("x-nonce") ?? undefined;
  // Admin "you have N link requests waiting" banner. Manual-approval mode
  // (SWAPCARD_REQUIRE_APPROVAL=1) has no other notification channel right
  // now — Twilio is configured but TWILIO_FROM is blank, so the SMS sender
  // no-ops. Without this, the admin had to remember to visit /admin/link-
  // requests. Renders on every page when the admin cookie is set AND there
  // are pending rows. Two cheap DB ops per request when admin; zero otherwise.
  const admin = await isAdmin();
  const pendingCount = admin ? countPendingLinkRequests() : 0;
  return (
    <html lang="en">
      {/* suppressHydrationWarning on <body> tolerates browser extensions
          (VSCode-style "vsc-initialized", dark-reader, etc.) that mutate the
          DOM before React hydrates. Doesn't suppress real mismatches in
          children. */}
      <body suppressHydrationWarning>
        <script
          type="application/ld+json"
          nonce={nonce}
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        {admin && pendingCount > 0 ? (
          <a
            href="/admin/link-requests"
            style={{
              display: "block",
              background: "rgba(241, 196, 15, 0.18)",
              borderBottom: "1px solid rgba(241, 196, 15, 0.5)",
              color: "var(--ink)",
              textDecoration: "none",
              padding: "0.5rem 1rem",
              fontSize: "0.9rem",
              textAlign: "center",
            }}
          >
            ⏳ {pendingCount} link request{pendingCount === 1 ? "" : "s"} pending
            admin approval — review →
          </a>
        ) : null}
        {children}
      </body>
    </html>
  );
}
