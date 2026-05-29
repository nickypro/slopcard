import crypto from "crypto";

// OpenRouter OAuth (PKCE) — lets a user grant slopcard an OpenRouter API key
// without copy-pasting one from openrouter.ai/keys. Parallel to the X OAuth
// flow in @/lib/oauth, but PKCE-only: there's no client_id/client_secret on
// OpenRouter's side. The exchange endpoint returns a usable `sk-or-v1-...`
// key directly (no access_token/refresh_token shape).
//
// Docs: https://openrouter.ai/docs/use-cases/oauth-pkce

const AUTHORIZE_URL = "https://openrouter.ai/auth";
const KEYS_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";

export function getCallbackUrl(): string {
  const site = process.env.SITE_URL || "http://localhost:3000";
  return `${site.replace(/\/$/, "")}/api/auth/openrouter/callback`;
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// PKCE verifier: RFC 7636 says 43–128 chars in the unreserved character set.
// 64 random bytes base64url'd lands at 86 chars, comfortably inside the range.
export function makePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(64));
  const challenge = b64url(
    crypto.createHash("sha256").update(verifier).digest()
  );
  return { verifier, challenge };
}

export function makeState(): string {
  return b64url(crypto.randomBytes(24));
}

export function buildAuthorizeUrl(challenge: string): string {
  // OpenRouter's authorize URL only documents three query params; there's no
  // `state` field on their side, so we keep PKCE-state in our own cookie and
  // bind it loosely via the cookie's max-age. (We still mint a state string
  // and store it server-side so we can detect a stale/cross-tab callback.)
  const params = new URLSearchParams({
    callback_url: getCallbackUrl(),
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export interface KeyExchangeResponse {
  key: string;
}

// Exchange the one-time `code` from the callback for a long-lived user key.
// The endpoint is unauthenticated; the only "auth" is proving we hold the
// matching code_verifier for the challenge we sent at authorize time.
export async function exchangeCode(
  code: string,
  verifier: string
): Promise<KeyExchangeResponse | null> {
  const res = await fetch(KEYS_EXCHANGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      code_challenge_method: "S256",
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { key?: unknown };
  if (typeof data.key !== "string" || !data.key) return null;
  return { key: data.key };
}
