import { NextResponse } from "next/server";
import { getUserSession } from "@/lib/session";
import { isConfigured } from "@/lib/oauth";

export const dynamic = "force-dynamic";

export async function GET() {
  const configured = isConfigured();
  const session = await getUserSession();
  if (!session) {
    return NextResponse.json({ signedIn: false, configured });
  }
  return NextResponse.json({
    signedIn: true,
    configured,
    twitterId: session.twitterId,
    twitterHandle: session.twitterHandle,
  });
}
