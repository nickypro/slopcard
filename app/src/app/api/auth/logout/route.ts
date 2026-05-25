import { NextResponse } from "next/server";
import { clearUserSession } from "@/lib/session";
import { siteUrl } from "@/lib/urls";

export const dynamic = "force-dynamic";

export async function POST() {
  await clearUserSession();
  return NextResponse.redirect(siteUrl("/"));
}
