import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { runIngest } from "@/lib/swapcard/ingest";

export const dynamic = "force-dynamic";

// Admin-only because it's slow (downloads model + embeds ~2k profiles) and
// hits an external sheet endpoint. Runs synchronously inside the request —
// the caller is expected to be a human waiting on the response.
export async function POST() {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  try {
    const result = await runIngest({
      onProgress: (m) => console.log(`[swapcard:ingest] ${m}`),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[swapcard:ingest] failed", e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
