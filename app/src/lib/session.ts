import { cookies } from "next/headers";
import crypto from "crypto";

// Signed user-session cookie. Format: <base64url(json)>.<base64url(hmac)>.
// json = { tid, th, exp }
//   tid = Twitter user id (string of digits)
//   th  = Twitter handle (lowercase)
//   exp = unix epoch seconds

const COOKIE_NAME = "slopcard_user";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface UserSession {
  twitterId: string;
  twitterHandle: string;
  exp: number;
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(
    s.replace(/-/g, "+").replace(/_/g, "/") +
      "===".slice((s.length + 3) % 4),
    "base64"
  );
}

function sign(payload: string): string {
  const secret = process.env.SESSION_SECRET || "";
  if (!secret) throw new Error("SESSION_SECRET not set");
  return b64url(crypto.createHmac("sha256", secret).update(payload).digest());
}

function encodeSession(s: UserSession): string {
  const json = JSON.stringify({
    tid: s.twitterId,
    th: s.twitterHandle,
    exp: s.exp,
  });
  const payload = b64url(Buffer.from(json));
  const sig = sign(payload);
  return `${payload}.${sig}`;
}

function decodeSession(value: string): UserSession | null {
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  let expected: string;
  try {
    expected = sign(payload);
  } catch {
    return null;
  }
  // constant time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  let obj: { tid?: string; th?: string; exp?: number };
  try {
    obj = JSON.parse(fromB64url(payload).toString("utf8"));
  } catch {
    return null;
  }
  if (!obj.tid || !obj.th || !obj.exp) return null;
  if (Date.now() / 1000 > obj.exp) return null;
  return {
    twitterId: obj.tid,
    twitterHandle: String(obj.th).toLowerCase(),
    exp: obj.exp,
  };
}

export async function setUserSession(
  twitterId: string,
  twitterHandle: string
): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS;
  const value = encodeSession({
    twitterId,
    twitterHandle: twitterHandle.toLowerCase(),
    exp,
  });
  const c = await cookies();
  c.set(COOKIE_NAME, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function getUserSession(): Promise<UserSession | null> {
  const c = await cookies();
  const v = c.get(COOKIE_NAME)?.value;
  if (!v) return null;
  return decodeSession(v);
}

export async function clearUserSession(): Promise<void> {
  const c = await cookies();
  c.delete(COOKIE_NAME);
}

// Helpers for short-lived PKCE state during the OAuth round-trip.
const PKCE_COOKIE = "slopcard_oauth";

export async function setPkceState(
  verifier: string,
  state: string
): Promise<void> {
  const c = await cookies();
  const value = `${state}.${verifier}`;
  c.set(PKCE_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600, // 10 minutes is plenty for an OAuth round-trip
  });
}

export async function consumePkceState(): Promise<{
  verifier: string;
  state: string;
} | null> {
  const c = await cookies();
  const v = c.get(PKCE_COOKIE)?.value;
  if (!v) return null;
  c.delete(PKCE_COOKIE);
  const idx = v.indexOf(".");
  if (idx < 0) return null;
  return { state: v.slice(0, idx), verifier: v.slice(idx + 1) };
}

// OpenRouter PKCE state is kept in its own short-lived cookie so it can't
// collide with the X (Twitter) round-trip if a user happens to start both.
// iter 19 pen-test: payload now includes `tid` (twitter id) so /callback
// can verify the same X session that started the flow is the one finishing
// it. Without this binding, an attacker can swap their own OpenRouter code
// into a victim's callback and bind their key to the victim's account.
//
// Encoding: `<state>.<tid>.<verifier>`. `tid` is digits-only and verifier
// is base64url, so a single dot delimiter is unambiguous via the last-dot
// for verifier and first-dot for state.
const OPENROUTER_PKCE_COOKIE = "slopcard_openrouter_oauth";

export interface OpenRouterPkcePayload {
  verifier: string;
  state: string;
  tid: string;
}

// Encode with a delimiter that doesn't appear in base64url (verifier) or
// the digit-only `tid`. Pipe `|` is outside base64url so the verifier
// can't contain it; state is also base64url. Use that.
function encodeOpenRouterPkce(p: OpenRouterPkcePayload): string {
  return `${p.state}|${p.tid}|${p.verifier}`;
}

function decodeOpenRouterPkce(value: string): OpenRouterPkcePayload | null {
  const parts = value.split("|");
  if (parts.length !== 3) return null;
  const [state, tid, verifier] = parts;
  if (!state || !tid || !verifier) return null;
  return { state, tid, verifier };
}

export async function setOpenRouterPkceState(
  verifier: string,
  state: string,
  tid: string
): Promise<void> {
  const c = await cookies();
  const value = encodeOpenRouterPkce({ verifier, state, tid });
  c.set(OPENROUTER_PKCE_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
}

export async function consumeOpenRouterPkceState(): Promise<OpenRouterPkcePayload | null> {
  const c = await cookies();
  const v = c.get(OPENROUTER_PKCE_COOKIE)?.value;
  if (!v) return null;
  c.delete(OPENROUTER_PKCE_COOKIE);
  return decodeOpenRouterPkce(v);
}

/**
 * @internal Test-only round-trip for the PKCE codec. The `__test__` prefix
 * + `@internal` JSDoc keep this clearly scoped — only the openrouter-oauth
 * test suite should import it. Reason for export: the cookies() API only
 * works inside a Next.js request scope, so the codec is the only thing a
 * unit test can exercise directly. iter 19 pen-test (LOW): scope discipline.
 */
export const __test__openRouterPkceCodec = {
  encode: encodeOpenRouterPkce,
  decode: decodeOpenRouterPkce,
};

// Signed OpenRouter-key cookie. Format mirrors the user-session scheme
// (`<base64url(json)>.<hmac>`) so we get the same tamper-resistance off the
// shared SESSION_SECRET. Keeping it in an httpOnly cookie means JS in the
// browser can't read the raw key — only the server attaches it to discover
// calls. Json payload: { key, exp }.

const OPENROUTER_COOKIE = "slopcard_openrouter";
const OPENROUTER_MAX_AGE_SECONDS = 60 * 60 * 24 * 90; // 90 days

interface OpenRouterCookiePayload {
  key: string;
  exp: number;
}

function encodeOpenRouterCookie(p: OpenRouterCookiePayload): string {
  const json = JSON.stringify({ key: p.key, exp: p.exp });
  const payload = b64url(Buffer.from(json));
  const sig = sign(payload);
  return `${payload}.${sig}`;
}

function decodeOpenRouterCookie(value: string): OpenRouterCookiePayload | null {
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  let expected: string;
  try {
    expected = sign(payload);
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  let obj: { key?: string; exp?: number };
  try {
    obj = JSON.parse(fromB64url(payload).toString("utf8"));
  } catch {
    return null;
  }
  if (!obj.key || !obj.exp) return null;
  if (Date.now() / 1000 > obj.exp) return null;
  return { key: obj.key, exp: obj.exp };
}

/**
 * @internal Test-only round-trip for the OpenRouter cookie codec. The
 * `__test__` prefix + `@internal` JSDoc tell readers (and tooling) this
 * isn't intended for production code paths — it exists because the
 * cookies() API only works inside a Next.js request scope, so unit tests
 * need a direct handle on the codec. iter 19 pen-test (LOW): scope
 * discipline.
 */
export const __test__openRouterCookieCodec = {
  encode: encodeOpenRouterCookie,
  decode: decodeOpenRouterCookie,
};

export async function setOpenRouterKey(key: string): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + OPENROUTER_MAX_AGE_SECONDS;
  const value = encodeOpenRouterCookie({ key, exp });
  const c = await cookies();
  c.set(OPENROUTER_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: OPENROUTER_MAX_AGE_SECONDS,
  });
}

export async function getOpenRouterKey(): Promise<string | null> {
  const c = await cookies();
  const v = c.get(OPENROUTER_COOKIE)?.value;
  if (!v) return null;
  const decoded = decodeOpenRouterCookie(v);
  return decoded?.key ?? null;
}

export async function clearOpenRouterKey(): Promise<void> {
  const c = await cookies();
  c.delete(OPENROUTER_COOKIE);
}
