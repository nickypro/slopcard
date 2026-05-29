import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { listEventSessions } from "@/lib/db";
import { sessionsToICSCalendar } from "@/lib/swapcard/ics";

export const dynamic = "force-dynamic";

// Full-agenda .ics export — designed for calendar subscription (webcal://).
// Same token gate as the per-event endpoint: SWAPCARD_AGENDA_PUBLIC_TOKEN
// must be set AND the request must supply ?t=<token>, otherwise 401. The
// agenda is technically public on Swapcard, but slopcard's own /agenda
// page is gated, and we don't want to silently undo that gate by exposing
// an unauthenticated mirror at a guessable URL.
//
// Logging: never log the supplied token. If we want hit counters in
// future, count successful matches only — never the raw query string.
export async function GET(req: NextRequest) {
  const gate = checkToken(req);
  if (!gate.ok) return gate.response;

  const eventId = process.env.SWAPCARD_EVENT_ID || "eag-london-2026";
  const sessions = listEventSessions(eventId);
  const body = sessionsToICSCalendar(sessions, {
    calName: "slopcard agenda",
  });
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="slopcard-agenda.ics"',
      // Calendar clients re-fetch subscriptions on their own schedule
      // (typically 15-60 min). A 5-minute server-side cache absorbs
      // bursts without letting stale agendas linger.
      "Cache-Control": "public, max-age=300",
    },
  });
}

// Same shape as /api/calendar/event/[planningId]/route.ts — see notes there.
function checkToken(
  req: NextRequest
):
  | { ok: true }
  | { ok: false; response: NextResponse } {
  const required = process.env.SWAPCARD_AGENDA_PUBLIC_TOKEN || "";
  if (!required) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "calendar export disabled" },
        { status: 401 }
      ),
    };
  }
  const supplied = req.nextUrl.searchParams.get("t") || "";
  const a = Buffer.from(required);
  const b = Buffer.from(supplied);
  let ok = false;
  if (a.length === b.length) {
    try {
      ok = crypto.timingSafeEqual(a, b);
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    return {
      ok: false,
      response: NextResponse.json({ error: "invalid token" }, { status: 401 }),
    };
  }
  return { ok: true };
}
