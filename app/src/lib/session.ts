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
