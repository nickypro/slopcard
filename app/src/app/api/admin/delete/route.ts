import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { deleteCard, getCard } from "@/lib/db";
import { siteUrl } from "@/lib/urls";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const form = await req.formData().catch(() => null);
  const handle = String(form?.get("handle") || "");
  const card = getCard(handle);
  if (!card) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  deleteCard(handle, "admin");
  return NextResponse.redirect(siteUrl("/admin"));
}
