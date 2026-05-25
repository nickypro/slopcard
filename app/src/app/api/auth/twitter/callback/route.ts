import { NextRequest, NextResponse } from "next/server";
import { exchangeCode, fetchMe } from "@/lib/oauth";
import { consumePkceState, setUserSession } from "@/lib/session";

export const dynamic = "force-dynamic";

function bounce(req: NextRequest, error: string) {
  return NextResponse.redirect(
    new URL(`/?auth_error=${encodeURIComponent(error)}`, req.url)
  );
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const err = req.nextUrl.searchParams.get("error");

  if (err) return bounce(req, err);
  if (!code || !state) return bounce(req, "missing_code_or_state");

  const pkce = await consumePkceState();
  if (!pkce) return bounce(req, "pkce_expired");
  if (pkce.state !== state) return bounce(req, "state_mismatch");

  const token = await exchangeCode(code, pkce.verifier).catch(() => null);
  if (!token) return bounce(req, "token_exchange_failed");

  const me = await fetchMe(token.access_token).catch(() => null);
  if (!me) return bounce(req, "user_fetch_failed");

  await setUserSession(me.id, me.username);
  return NextResponse.redirect(new URL("/?signed_in=1", req.url));
}
