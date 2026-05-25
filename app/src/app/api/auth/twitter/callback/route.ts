import { NextRequest, NextResponse } from "next/server";
import { exchangeCode, fetchMe } from "@/lib/oauth";
import { consumePkceState, setUserSession } from "@/lib/session";
import { siteUrl } from "@/lib/urls";

export const dynamic = "force-dynamic";

function bounce(error: string) {
  return NextResponse.redirect(
    siteUrl(`/submit?auth_error=${encodeURIComponent(error)}`)
  );
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const err = req.nextUrl.searchParams.get("error");

  if (err) return bounce(err);
  if (!code || !state) return bounce("missing_code_or_state");

  const pkce = await consumePkceState();
  if (!pkce) return bounce("pkce_expired");
  if (pkce.state !== state) return bounce("state_mismatch");

  const token = await exchangeCode(code, pkce.verifier).catch(() => null);
  if (!token) return bounce("token_exchange_failed");

  const me = await fetchMe(token.access_token).catch(() => null);
  if (!me) return bounce("user_fetch_failed");

  await setUserSession(me.id, me.username);
  return NextResponse.redirect(siteUrl("/submit?signed_in=1"));
}
