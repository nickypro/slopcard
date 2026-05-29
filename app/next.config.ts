import type { NextConfig } from "next";

// Site-wide security headers (iter 19 pen-test defense-in-depth).
// SPLIT: `Content-Security-Policy` is owned by `src/middleware.ts` because it
// needs a per-request nonce for Next.js 15's framework-injected inline
// hydration scripts (see Next.js docs on content-security-policy#nonces).
// The headers below are static — no nonce needed — so they live here where
// they hit every route (including static assets and API) via next.config.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3", "sharp"],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "pbs.twimg.com" },
      { protocol: "https", hostname: "abs.twimg.com" },
      { protocol: "https", hostname: "unavatar.io" },
    ],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
