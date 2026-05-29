import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import {
  decideLinkRequest,
  getLinkRequestById,
  linkSwapcardToCard,
} from "@/lib/db";
import { siteUrl } from "@/lib/urls";

export const dynamic = "force-dynamic";

// Admin decision handler for pending Swapcard link requests. On approve,
// performs the real linkSwapcardToCard call before marking the request
// approved — so if the link is no longer possible (e.g. someone else
// claimed it in the meantime), the request stays pending and the admin
// can decide whether to reject or chase up.
export async function POST(req: NextRequest) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const form = await req.formData().catch(() => null);
  const idStr = String(form?.get("id") || "");
  const action = String(form?.get("action") || "");
  const id = Number(idStr);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "missing id" }, { status: 400 });
  }
  if (action !== "approve" && action !== "reject") {
    return NextResponse.json({ error: "bad action" }, { status: 400 });
  }
  const request = getLinkRequestById(id);
  if (!request) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (request.state !== "pending") {
    // Already decided. Redirect to the queue so the admin can see the
    // current state instead of returning a confusing 409.
    return NextResponse.redirect(siteUrl("/admin/link-requests"));
  }

  if (action === "approve") {
    const result = linkSwapcardToCard(
      request.handle,
      request.eventId,
      request.personId,
      "admin"
    );
    if (!result.ok) {
      // Leave the request pending so it stays in the queue; surface the
      // reason as a query string for the admin's reference.
      return NextResponse.redirect(
        siteUrl(`/admin/link-requests?error=${encodeURIComponent(result.reason)}`)
      );
    }
    decideLinkRequest(id, "approved", "admin");
  } else {
    decideLinkRequest(id, "rejected", "admin");
  }
  return NextResponse.redirect(siteUrl("/admin/link-requests"));
}
