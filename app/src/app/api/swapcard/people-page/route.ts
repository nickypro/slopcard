import { NextRequest, NextResponse } from "next/server";
import {
  getCard,
  getSwapcardAttendeeByAnyId,
  searchSwapcardAttendees,
  searchSwapcardAttendeesByCloseness,
} from "@/lib/db";
import { getUserSession } from "@/lib/session";
import { claimCheapSlot } from "@/lib/swapcard/rate-limit";

export const dynamic = "force-dynamic";

// Hard upper bound matches /people's PAGE_SIZE. Larger limits would still
// work but the client never asks for more than this and the cap stops a
// malicious POST from exploding the OFFSET.
const MAX_LIMIT = 50;
// Mirror of /people's MAX_PAGE * PAGE_SIZE so a runaway offset can't ask
// SQLite to scan past the dataset cap (10k rows).
const MAX_OFFSET = 200 * 50;

// Server companion for the /people infinite-scroll client. Same auth gates
// as the page route (session + card + linked attendee). Reuses the same
// search helper, so behaviour stays in lockstep with the SSR'd first page.
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

  // Reuse the "saved" cheap bucket — cost profile is the same shape (one
  // bounded SQL scan, no upstream fan-out). A dedicated bucket would be cleaner
  // but burns kind-space without a real isolation benefit.
  const slot = claimCheapSlot({ handle: session.twitterHandle, kind: "saved" });
  if (!slot.allow) {
    return NextResponse.json(
      { error: "slow down — too many requests" },
      {
        status: 429,
        headers: { "Retry-After": String(slot.retryAfterSec) },
      }
    );
  }

  try {
    let body: {
      q?: unknown;
      c?: unknown;
      offset?: unknown;
      limit?: unknown;
      sort?: unknown;
    } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      /* optional body */
    }

    const q = typeof body.q === "string" ? body.q : "";
    const causeArea = typeof body.c === "string" ? body.c : "";
    const sort = body.sort === "closeness" ? "closeness" : "alphabetical";
    const rawOffset =
      typeof body.offset === "number" ? body.offset : 0;
    const rawLimit =
      typeof body.limit === "number" ? body.limit : MAX_LIMIT;
    const offset = Math.max(
      0,
      Math.min(MAX_OFFSET, Math.floor(rawOffset))
    );
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(rawLimit)));

    const eventId =
      card.swapcardEventId ||
      process.env.SWAPCARD_EVENT_ID ||
      "eag-london-2026";

    // Closeness needs the requester's embedding so the rank is consistent
    // with the server-rendered first page. Falls back to alphabetical if the
    // linked row has no embedding (only happens for hand-edited stub linkages).
    if (sort === "closeness" && card.swapcardEventId && card.swapcardPersonId) {
      const me = getSwapcardAttendeeByAnyId(
        card.swapcardEventId,
        card.swapcardPersonId
      );
      if (me?.embedding && me.embedding.length > 0) {
        const { results, total } = searchSwapcardAttendeesByCloseness(
          eventId,
          q,
          me.embedding,
          limit,
          offset,
          causeArea || undefined
        );
        return NextResponse.json({ ok: true, results, total });
      }
    }

    const { results, total } = searchSwapcardAttendees(
      eventId,
      q,
      limit,
      offset,
      causeArea || undefined
    );

    return NextResponse.json({ ok: true, results, total });
  } finally {
    slot.release();
  }
}
