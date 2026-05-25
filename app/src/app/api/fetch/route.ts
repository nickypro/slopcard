import { NextRequest, NextResponse } from "next/server";
import { fetchTwitterProfile } from "@/lib/twitter";
import { normalizeHandle } from "@/lib/handle";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const h = normalizeHandle(req.nextUrl.searchParams.get("h") || "");
  if (!h || !/^[A-Za-z0-9_]{1,15}$/.test(h)) {
    return NextResponse.json({ error: "invalid handle" }, { status: 400 });
  }
  const profile = await fetchTwitterProfile(h);
  return NextResponse.json(profile);
}
