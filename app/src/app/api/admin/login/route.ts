import { NextRequest, NextResponse } from "next/server";
import { setAdminCookie, verifyToken } from "@/lib/auth";
import { siteUrl } from "@/lib/urls";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") || "";
  if (!verifyToken(token)) {
    return NextResponse.redirect(siteUrl("/admin/login?error=1"));
  }
  await setAdminCookie(token);
  return NextResponse.redirect(siteUrl("/admin"));
}

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const token = form ? String(form.get("token") || "") : "";
  if (!verifyToken(token)) {
    return NextResponse.redirect(siteUrl("/admin/login?error=1"));
  }
  await setAdminCookie(token);
  return NextResponse.redirect(siteUrl("/admin"));
}
