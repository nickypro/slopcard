import { NextRequest, NextResponse } from "next/server";
import { clearUserSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  await clearUserSession();
  return NextResponse.redirect(new URL("/", req.url));
}
