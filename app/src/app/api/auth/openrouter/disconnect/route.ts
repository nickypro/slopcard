import { NextResponse } from "next/server";
import { clearOpenRouterKey, getUserSession } from "@/lib/session";

export const dynamic = "force-dynamic";

// Drop the signed OpenRouter cookie set by the PKCE flow. POST-only so a
// stray <a> click can't logout the user via CSRF; the X session is required
// so a stranger with the cookie name can't clear someone else's key.
//
// After disconnect:
//   - free-handle users (SWAPCARD_FREE_HANDLES) fall back to the server env
//     key (callLlmJson default).
//   - everyone else lands on the /discover BYOK prompt next time, where they
//     can paste a key or re-OAuth.
export async function POST() {
  const session = await getUserSession();
  if (!session) {
    return NextResponse.json({ error: "sign in with X first" }, { status: 401 });
  }
  await clearOpenRouterKey();
  return NextResponse.json({ ok: true });
}
