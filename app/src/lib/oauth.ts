import crypto from "crypto";

// X / Twitter OAuth 2.0 (Authorization Code with PKCE).
// Docs: https://developer.x.com/en/docs/authentication/oauth-2-0/authorization-code

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const USERS_ME_URL =
  "https://api.x.com/2/users/me?user.fields=name,username,description,profile_image_url";

export function isConfigured(): boolean {
  return !!(
    process.env.TWITTER_CLIENT_ID && process.env.TWITTER_CLIENT_SECRET
  );
}

export function getRedirectUri(): string {
  const site = process.env.SITE_URL || "http://localhost:3000";
  return `${site.replace(/\/$/, "")}/api/auth/twitter/callback`;
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

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

export function buildAuthorizeUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.TWITTER_CLIENT_ID || "",
    redirect_uri: getRedirectUri(),
    scope: "users.read tweet.read offline.access",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

export async function exchangeCode(
  code: string,
  verifier: string
): Promise<TokenResponse | null> {
  const clientId = process.env.TWITTER_CLIENT_ID;
  const clientSecret = process.env.TWITTER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    client_id: clientId,
    redirect_uri: getRedirectUri(),
    code_verifier: verifier,
  });
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: body.toString(),
  });
  if (!res.ok) return null;
  return (await res.json()) as TokenResponse;
}

export interface TwitterMe {
  id: string;
  username: string;
  name: string;
  description?: string;
  profile_image_url?: string;
}

export async function fetchMe(
  accessToken: string
): Promise<TwitterMe | null> {
  const res = await fetch(USERS_ME_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { data?: TwitterMe };
  if (!data.data?.id) return null;
  return data.data;
}
