import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { replaceEventSessions } from "@/lib/db";
import { fetchEventSessionsBatch } from "@/lib/swapcard/scrape-agenda-events";
import { classifyDiscoverError } from "@/lib/swapcard/error-classifier";

export const dynamic = "force-dynamic";

// Admin-only: scrape the conference's GENERAL agenda (talks, plenaries,
// workshops) using a bearer JWT the admin supplies, replacing the cached
// event_sessions rows for the configured event. Bearer token is consumed
// only for this request — nothing's persisted to disk (same pattern as
// match-event-people / refresh-slots).
//
// IMPORTANT: SWAPCARD_AGENDA_EVENT_ID is the BASE64-ENCODED Swapcard event
// id (e.g. RXZlbnRfNDQzNjA4NQ== for EAG London 2026), which is what
// Swapcard's GraphQL layer expects. This is NOT the same value as the
// logical SWAPCARD_EVENT_ID (e.g. "eag-london-2026") we use as the DB
// partition key elsewhere — they sit in different namespaces.
//
// Body: { token: string, viewId?: string, eventId?: string, timezone?: string }
export async function POST(req: NextRequest) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }

  let body: {
    token?: unknown;
    viewId?: unknown;
    eventId?: unknown;
    timezone?: unknown;
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

  // Same allowlist concept as match-event-people: lock the admin scrape to
  // a known view. Empty/unset = no enforcement (backward-compatible).
  const allowedViewIds = (process.env.SWAPCARD_ALLOWED_VIEW_IDS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const viewId =
    (typeof body.viewId === "string" && body.viewId.trim()) ||
    process.env.SWAPCARD_AGENDA_VIEW_ID ||
    "RXZlbnRWaWV3XzEyNzQyMDA=";
  if (allowedViewIds.length && !allowedViewIds.includes(viewId)) {
    return NextResponse.json(
      {
        error:
          "viewId not in SWAPCARD_ALLOWED_VIEW_IDS — refusing to scrape an arbitrary view",
      },
      { status: 400 }
    );
  }

  // base64-encoded Swapcard event id; differs from the logical eventId
  // we use as the DB partition key.
  const swapcardEventId =
    (typeof body.eventId === "string" && body.eventId.trim()) ||
    process.env.SWAPCARD_AGENDA_EVENT_ID ||
    "RXZlbnRfNDQzNjA4NQ==";
  const timezone =
    (typeof body.timezone === "string" && body.timezone.trim()) ||
    process.env.SWAPCARD_AGENDA_TZ ||
    "Europe/London";

  // Logical eventId (not the Swapcard base64) — what /agenda reads with.
  const eventId = process.env.SWAPCARD_EVENT_ID || "eag-london-2026";

  try {
    const t0 = Date.now();
    const scrape = await fetchEventSessionsBatch({
      bearerToken: token,
      eventId: swapcardEventId,
      viewId,
      timezone,
      onProgress: (done, total) => {
        if (done % 25 === 0 || done === total) {
          console.log(`[swapcard:agenda] scraped ${done}/${total || "?"}`);
        }
      },
    });
    replaceEventSessions(eventId, scrape.sessions);
    return NextResponse.json({
      ok: true,
      scraped: scrape.sessions.length,
      days: scrape.pagesFetched,
      durationMs: Date.now() - t0,
    });
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // Raw error hits stderr for ops debugging; the wire response gets the
    // sanitised category so a leaked bearer doesn't bounce back in the body.
    console.error("[swapcard:agenda] failed", e);
    return NextResponse.json(
      { ok: false, error: classifyDiscoverError(raw) },
      { status: 500 }
    );
  }
}
