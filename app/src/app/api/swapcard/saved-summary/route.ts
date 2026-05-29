import { NextRequest, NextResponse } from "next/server";
import {
  getAttendeeSlots,
  getCard,
  getSwapcardAttendeeByAnyId,
  listSavedAttendees,
} from "@/lib/db";
import { getUserSession } from "@/lib/session";
import { claimCheapSlot } from "@/lib/swapcard/rate-limit";

export const dynamic = "force-dynamic";

// 24h matches /agenda's tolerance — once slots are scraped they stay useful
// until the next admin refresh, and we'd rather show an overlap count from
// yesterday than no count at all. The discover badges use 15min because
// they're noisier; this page is the considered list.
const SLOT_TTL_SEC = 60 * 60 * 24;

// Defensive cap so a malformed localStorage payload doesn't generate a
// huge IN clause AND so the response can't be abused as a slot-overlap
// membership oracle on the requester's own calendar (iter 19 pen-test:
// lowered from 200 → 50). 50 saves is still well beyond any plausible
// attendee shortlist for a 3-day conference; client now 400s if it tries
// to ship more, surfacing the constraint instead of silently slicing.
const MAX_IDS = 50;

// Server-side resolver for the /saved page. The page itself can't read
// localStorage (it's server-rendered), so the client posts the saved IDs
// here and we return rows + overlap counts in one shot.
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

  // Cheap-bucket rate limit (iter 19 pen-test). Per-handle slot-overlap
  // rollup can scan up to MAX_IDS attendees; bound the call rate so a
  // looped client can't pin CPU.
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
    let body: { personIds?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      /* optional body */
    }
    const raw = Array.isArray(body.personIds) ? body.personIds : [];
    // Hard-reject (iter 19 pen-test) rather than silently slicing — the
    // client should know the constraint exists. Counted on the raw input
    // length so a flood of empties or non-strings still trips the gate.
    if (raw.length > MAX_IDS) {
      return NextResponse.json(
        { error: `too many ids (max ${MAX_IDS})` },
        { status: 400 }
      );
    }
    const personIds: string[] = [];
    for (const v of raw) {
      if (typeof v === "string" && v.length > 0) personIds.push(v);
    }

    const eventId = process.env.SWAPCARD_EVENT_ID || "eag-london-2026";

    // Resolve the requester's own free slots so we can compute overlap.
    // Missing event_people_id (or no cached slots) collapses to mySlotStarts =
    // null, which the loop below renders as "overlap unknown".
    const me = getSwapcardAttendeeByAnyId(eventId, card.swapcardPersonId);
    let mySlotStarts: Set<string> | null = null;
    if (me?.eventPeopleId) {
      const cached = getAttendeeSlots(eventId, me.eventPeopleId, SLOT_TTL_SEC);
      if (cached) {
        try {
          const parsed = JSON.parse(cached.slotsJson);
          if (Array.isArray(parsed)) {
            mySlotStarts = new Set();
            for (const s of parsed) {
              if (s && typeof s.starts === "string") mySlotStarts.add(s.starts);
            }
          }
        } catch {
          /* malformed cache row — treat as no slots */
        }
      }
    }

    const rows = listSavedAttendees(eventId, personIds, SLOT_TTL_SEC);
    const items = rows.map((r) => {
      let overlapWithMe = 0;
      if (mySlotStarts) {
        for (const start of r.slotStarts) {
          if (mySlotStarts.has(start)) overlapWithMe += 1;
        }
      }
      // Drop slotStarts from the response so we don't ship the user's calendar
      // overlap details over the wire — only the aggregate count is needed.
      return {
        personId: r.personId,
        eventPeopleId: r.eventPeopleId,
        firstName: r.firstName,
        lastName: r.lastName,
        jobTitle: r.jobTitle,
        company: r.company,
        country: r.country,
        hasPhoto: r.hasPhoto,
        swapcardUrl: r.swapcardUrl,
        overlapWithMe,
      };
    });

    return NextResponse.json({
      ok: true,
      items,
      myHasSlots: mySlotStarts !== null,
    });
  } finally {
    slot.release();
  }
}
