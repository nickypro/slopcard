import { NextResponse } from "next/server";
import {
  buildAuthorizeUrl,
  makePkce,
  makeState,
} from "@/lib/openrouter";
import { getUserSession, setOpenRouterPkceState } from "@/lib/session";

export const dynamic = "force-dynamic";

// Kicks off the OpenRouter PKCE round-trip. Unlike X OAuth this doesn't need
// a server-side client_id/client_secret — PKCE alone is what binds the code
// to the verifier we just stashed in our cookie.
//
// iter 19 pen-test: gated on X session and binds the resulting PKCE
// payload to the user's twitter id so the /callback can verify it's the
// same browser that started the flow. Without this, an attacker can stage
// their own OpenRouter code in a victim's callback and bind their key
// to the victim's slopcard account.
export async function GET() {
  const session = await getUserSession();
  if (!session) {
    return NextResponse.json(
      { error: "sign in with X first" },
      { status: 401 }
    );
  }
  const { verifier, challenge } = makePkce();
  const state = makeState();
  await setOpenRouterPkceState(verifier, state, session.twitterId);
  const url = buildAuthorizeUrl(challenge);
  return NextResponse.redirect(url);
}
