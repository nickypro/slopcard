import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { approveCard } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const form = await req.formData().catch(() => null);
  const handle = String(form?.get("handle") || "");
  if (!handle) {
    return NextResponse.json({ error: "missing handle" }, { status: 400 });
  }
  const card = approveCard(handle);
  if (!card) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.redirect(new URL("/admin", req.url));
}
