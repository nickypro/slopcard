import { NextResponse } from "next/server";
import { unlinkSwapcardFromCard } from "@/lib/db";
import { getUserSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST() {
  const session = await getUserSession();
  if (!session) {
    return NextResponse.json({ error: "sign in with X first" }, { status: 401 });
  }
  const actor = `verified:${session.twitterId}`;
  unlinkSwapcardFromCard(session.twitterHandle, actor);
  return NextResponse.json({ ok: true });
}
