import { cookies } from "next/headers";
import crypto from "crypto";

const COOKIE_NAME = "slopcard_admin";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

export function verifyToken(input: string): boolean {
  const token = process.env.ADMIN_TOKEN;
  if (!token || !input) return false;
  return safeEqual(input, token);
}

export async function isAdmin(): Promise<boolean> {
  const c = await cookies();
  const v = c.get(COOKIE_NAME)?.value;
  if (!v) return false;
  return verifyToken(v);
}

export async function setAdminCookie(value: string): Promise<void> {
  const c = await cookies();
  c.set(COOKIE_NAME, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}

export async function clearAdminCookie(): Promise<void> {
  const c = await cookies();
  c.delete(COOKIE_NAME);
}
