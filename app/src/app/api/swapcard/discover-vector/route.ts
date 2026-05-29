import { NextRequest, NextResponse } from "next/server";
import { getCard, getSwapcardAttendeeByAnyId } from "@/lib/db";
import { getUserSession } from "@/lib/session";
import { runVectorOnlyDiscover } from "@/lib/swapcard/discover-vector";
import { classifyDiscoverError, newErrId } from "@/lib/swapcard/error-classifier";
import { claimCheapSlot } from "@/lib/swapcard/rate-limit";
import type { Attendee } from "@/lib/swapcard/types";

export const dynamic = "force-dynamic";

// Free vector-only discover tier. Same auth + linkage gates as the LLM route
// but no BYOK, no rate-limit, no SSE — the work is bounded (one embedding +
// in-memory ranking) so a plain JSON round-trip is enough.
export async function POST(req: NextRequest) {
  const session = await getUserSession();
  if (!session) {
    return NextResponse.json({ error: "sign in with X first" }, { status: 401 });
  }
  const card = getCard(session.twitterHandle);
  if (!card) {
    return NextResponse.json(
      { error: "no card for this handle — submit one first" },
      { status: 404 }
    );
  }
  if (!card.swapcardPersonId || !card.swapcardEventId) {
    return NextResponse.json(
      { error: "link your Swapcard profile first" },
      { status: 412 }
    );
  }
  const attendeeRow = getSwapcardAttendeeByAnyId(
    card.swapcardEventId,
    card.swapcardPersonId
  );
  if (!attendeeRow) {
    return NextResponse.json(
      { error: "your linked attendee record isn't in the cache — re-ingest" },
      { status: 410 }
    );
  }
  const requester = JSON.parse(attendeeRow.profileJson) as Attendee;

  // Cheap-bucket rate limit (iter 19 pen-test). Bounded work per call
  // (one embedding + in-memory rank) but still pins CPU under a flood.
  const slot = claimCheapSlot({ handle: session.twitterHandle, kind: "vector" });
  if (!slot.allow) {
    return NextResponse.json(
      { error: "slow down — too many requests" },
      {
        status: 429,
        headers: { "Retry-After": String(slot.retryAfterSec) },
      }
    );
  }

  let body: { customPrompt?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* optional body */
  }
  const customPrompt =
    typeof body.customPrompt === "string" ? body.customPrompt.slice(0, 4000) : "";

  const goals = card.description?.trim() || requester.needHelp || "";

  try {
    const run = await runVectorOnlyDiscover({
      requester,
      requesterPersonId: card.swapcardPersonId,
      eventId: card.swapcardEventId,
      customPrompt,
      goals,
    });
    return NextResponse.json({ ok: true, run });
  } catch (e) {
    const errId = newErrId();
    console.error(
      `[swapcard:discover-vector] errId=${errId} handle=@${card.handle}`,
      e
    );
    const raw = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: classifyDiscoverError(raw, errId) },
      { status: 500 }
    );
  } finally {
    slot.release();
  }
}
