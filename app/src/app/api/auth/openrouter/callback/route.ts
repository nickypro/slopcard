import { NextRequest, NextResponse } from "next/server";
import { exchangeCode } from "@/lib/openrouter";
import {
  consumeOpenRouterPkceState,
  getUserSession,
  setOpenRouterKey,
} from "@/lib/session";
import { siteUrl } from "@/lib/urls";

export const dynamic = "force-dynamic";

function bounce(error: string) {
  return NextResponse.redirect(
    siteUrl(`/discover?openrouter_error=${encodeURIComponent(error)}`)
  );
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const err = req.nextUrl.searchParams.get("error");

  if (err) return bounce(err);
  if (!code) return bounce("missing_code");

  const pkce = await consumeOpenRouterPkceState();
  if (!pkce) return bounce("pkce_expired");

  // iter 19 pen-test: rebind to the X session that started the flow.
  // Without this, an attacker can stage their own code in a victim's
  // callback (or vice versa) and end up binding the wrong key to the
  // wrong account.
  const session = await getUserSession();
  if (!session || session.twitterId !== pkce.tid) {
    return bounce("session_mismatch");
  }

  const result = await exchangeCode(code, pkce.verifier).catch(() => null);
  if (!result) return bounce("token_exchange_failed");

  await setOpenRouterKey(result.key);
  return NextResponse.redirect(siteUrl("/discover?openrouter=linked"));
}
