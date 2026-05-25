import { NextResponse } from "next/server";
import { clearAdminCookie } from "@/lib/auth";
import { siteUrl } from "@/lib/urls";

export const dynamic = "force-dynamic";

export async function POST() {
  await clearAdminCookie();
  return NextResponse.redirect(siteUrl("/"));
}
