import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { listEventSessions } from "@/lib/db";
import { sessionToICS } from "@/lib/swapcard/ics";

export const dynamic = "force-dynamic";

// Per-session .ics download. Public on purpose — calendar subscription URLs
// can't carry auth cookies, so the only access control is the unguessable
// SWAPCARD_AGENDA_PUBLIC_TOKEN query param. If the env var is unset we 401
// every request so we never accidentally expose the agenda before an admin
// has explicitly chosen to share it.
//
// We DO NOT log the token value — only whether it matched. Leaking it in
// access logs would defeat the unguessability gate the same way leaking it
// in a response body would.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ planningId: string }> }
) {
  const gate = checkToken(req);
  if (!gate.ok) return gate.response;

  const { planningId } = await params;
  const eventId = process.env.SWAPCARD_EVENT_ID || "eag-london-2026";
  const sessions = listEventSessions(eventId);
  const session = sessions.find((s) => s.planningId === planningId);
  if (!session) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = sessionToICS(session, {
    calName: session.title || "slopcard agenda",
  });
  // Filename uses the planningId — it's already URL-safe (base64). We don't
  // try to derive one from the title because session titles routinely
  // contain commas/spaces/quotes and the filename* encoding dance isn't
  // worth it for what's essentially a one-click save.
  const filename = `slopcard-${planningId}.ics`;
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Short cache: schedules can change up to the day of the conference;
      // 5 min is enough to absorb a burst of clicks without serving stale
      // bytes for too long.
      "Cache-Control": "public, max-age=300",
    },
  });
}

// Shared token check used by both calendar routes. See route.ts in
// /api/calendar/all for the same logic — duplicated here so each route file
// is self-contained and easy to grep for. Constant-time compare via
// crypto.timingSafeEqual matches the rest of the codebase's auth helpers.
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
  // Constant-time compare against the env value. Length mismatch returns
  // false immediately — timingSafeEqual throws on differing buffer sizes.
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
