import { NextResponse, type NextRequest } from "next/server";

// Per-request nonce-based CSP (replaces the iter-19 hot-fix that used
// `'unsafe-inline' 'unsafe-eval'` on script-src). The nonce is generated
// here in the edge runtime via Web Crypto, attached to the request headers
// so server components can read it via `headers()`, and emitted as the
// `Content-Security-Policy` response header so the browser enforces it.
// `'strict-dynamic'` lets any script with the nonce load further scripts
// (Next.js's chunk loader) without us listing every URL.
export function middleware(request: NextRequest) {
  // Generate a per-request nonce. Web Crypto in edge runtime; no Node imports.
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = btoa(String.fromCharCode(...nonceBytes));

  // 'strict-dynamic' lets the framework hydrate without us listing every
  // chunk-loader URL — any script with the nonce can load further scripts.
  // 'self' is the static-CSP fallback for browsers that don't honour
  // 'strict-dynamic' (mostly fine in 2026 but doesn't hurt to keep).
  const cspParts = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: https://pbs.twimg.com https://abs.twimg.com https://unavatar.io`,
    `connect-src 'self'`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
  ];
  const csp = cspParts.join("; ");

  // Pass the nonce to the app via a request header. layout.tsx reads it via
  // `headers()` and applies it to any inline `<script>` it renders.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  // Also set CSP on the OUTGOING response so the browser receives it.
  response.headers.set("content-security-policy", csp);
  return response;
}

// Skip static asset and API routes. Per Next.js docs, the nonce only needs
// to flow through HTML responses; API routes return JSON and don't need it.
export const config = {
  matcher: [
    {
      source:
        "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
