import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import {
  listAttendeesWithEventPeopleId,
  setAttendeeSlots,
} from "@/lib/db";
import { fetchMeetSlotsBatch } from "@/lib/swapcard/scrape-agenda";

export const dynamic = "force-dynamic";

// Admin-only: fan out MeetSlotsQuery against Swapcard for every cached
// attendee that has an event_people_id mapped, persist the resulting slot
// arrays into attendee_slots, and let /discover read fresh counts from the
// DB on the next run. Bearer token is consumed only for this request —
// nothing's persisted to disk (same pattern as match-event-people).
//
// IMPORTANT: SWAPCARD_AGENDA_EVENT_ID is the BASE64-ENCODED Swapcard event
// id (e.g. RXZlbnRfNDQzNjA4NQ== for EAG London 2026), which is what
// Swapcard's GraphQL layer expects. This is NOT the same value as the
// logical SWAPCARD_EVENT_ID (e.g. "eag-london-2026") we use as the DB
// partition key elsewhere — they sit in different namespaces.
//
// Body:
//   { token: string,
//     peopleIds?: string[],
//     dateRange?: { start: string; end: string },
//     concurrency?: number }
export async function POST(req: NextRequest) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }

  let body: {
    token?: unknown;
    peopleIds?: unknown;
    dateRange?: unknown;
    concurrency?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) {
    return NextResponse.json(
      { error: "missing 'token' (Swapcard bearer JWT)" },
      { status: 400 }
    );
  }

  const eventId = process.env.SWAPCARD_EVENT_ID || "eag-london-2026";
  // base64-encoded Swapcard event id; differs from the logical eventId.
  const swapcardEventId =
    process.env.SWAPCARD_AGENDA_EVENT_ID || "RXZlbnRfNDQzNjA4NQ==";

  // iter 19 pen-test: only fan out against event_people_ids we have a
  // cached row for. Caller can't smuggle arbitrary ids into the Swapcard
  // GraphQL fan-out via a leaked admin token. Default (no body) is the
  // full allowed set; explicit list is intersected with allowed.
  const allowed = new Set(listAttendeesWithEventPeopleId(eventId));
  let peopleIds: string[];
  if (Array.isArray(body.peopleIds)) {
    const supplied = body.peopleIds.filter(
      (x): x is string => typeof x === "string"
    );
    peopleIds = supplied.filter((id) => allowed.has(id));
    if (supplied.length > 0 && peopleIds.length === 0) {
      return NextResponse.json(
        { error: "no known event_people_ids in request" },
        { status: 400 }
      );
    }
  } else {
    peopleIds = [...allowed];
  }

  const rawRange =
    body.dateRange && typeof body.dateRange === "object"
      ? (body.dateRange as { start?: unknown; end?: unknown })
      : null;
  const dateRange = {
    start:
      typeof rawRange?.start === "string"
        ? rawRange.start
        : process.env.SWAPCARD_AGENDA_START ||
          "2026-05-29T00:00:00+01:00",
    end:
      typeof rawRange?.end === "string"
        ? rawRange.end
        : process.env.SWAPCARD_AGENDA_END ||
          "2026-06-01T23:59:59+01:00",
  };

  const concurrency =
    typeof body.concurrency === "number" && body.concurrency > 0
      ? Math.floor(body.concurrency)
      : 5;

  if (peopleIds.length === 0) {
    return NextResponse.json({
      ok: true,
      refreshed: 0,
      withSlots: 0,
      durationMs: 0,
    });
  }

  try {
    const t0 = Date.now();
    const results = await fetchMeetSlotsBatch({
      bearerToken: token,
      eventId: swapcardEventId,
      peopleIds,
      dateRange,
      concurrency,
      onProgress: (done, total) => {
        if (done % 50 === 0 || done === total) {
          console.log(`[swapcard:slots] fetched ${done}/${total}`);
        }
      },
    });
    let withSlots = 0;
    for (const r of results) {
      if (!r) continue;
      setAttendeeSlots(eventId, r.peopleId, JSON.stringify(r.slots));
      if (r.slots.length > 0) withSlots += 1;
    }
    return NextResponse.json({
      ok: true,
      refreshed: results.length,
      withSlots,
      durationMs: Date.now() - t0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[swapcard:slots] failed", e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
