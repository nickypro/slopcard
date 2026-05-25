import { NextRequest, NextResponse } from "next/server";
import { setAdminCookie, verifyToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") || "";
  if (!verifyToken(token)) {
    return NextResponse.redirect(new URL("/admin/login?error=1", req.url));
  }
  await setAdminCookie(token);
  return NextResponse.redirect(new URL("/admin", req.url));
}

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const token = form ? String(form.get("token") || "") : "";
  if (!verifyToken(token)) {
    return NextResponse.redirect(new URL("/admin/login?error=1", req.url));
  }
  await setAdminCookie(token);
  return NextResponse.redirect(new URL("/admin", req.url));
}
