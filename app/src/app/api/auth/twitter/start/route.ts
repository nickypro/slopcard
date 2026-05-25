import { NextRequest, NextResponse } from "next/server";
import { buildAuthorizeUrl, isConfigured, makePkce, makeState } from "@/lib/oauth";
import { setPkceState } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isConfigured()) {
    return NextResponse.json(
      { error: "X sign-in is not configured on this server" },
      { status: 503 }
    );
  }
  const { verifier, challenge } = makePkce();
  const state = makeState();
  await setPkceState(verifier, state);
  const url = buildAuthorizeUrl(challenge, state);
  return NextResponse.redirect(url);
}
