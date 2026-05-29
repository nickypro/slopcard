// Hand-rolled RFC 5545 (iCalendar / VCALENDAR) emitter for the /agenda
// calendar-export buttons. No dep on `ical-generator` etc. — the format is
// small enough that a few helpers + careful escaping cover it.
//
// Output is suitable for both .ics download (open in Calendar.app / Google
// Calendar import) and as the body of a calendar subscription endpoint. The
// caller decides which by wiring it to a download Content-Disposition or a
// long-cache text/calendar route.
//
// Things this DOES NOT do (yet, intentionally):
// - VTIMEZONE blocks. We emit DTSTART/DTEND as floating UTC ("Z" suffix)
//   derived from the ISO offsets Swapcard returns. Calendar apps render the
//   correct local time because UTC is the canonical reference; the
//   wall-clock-vs-local-time question is the client's problem.
// - RRULE / recurring events. Conference sessions are one-offs.
// - Attendees, organizers, alarms. None of these are useful for a
//   read-only schedule export.

import type { ScrapedSession } from "@/lib/swapcard/scrape-agenda-events";

interface IcsOptions {
  // X-WR-CALNAME — what the imported calendar is called in Calendar.app /
  // Google Calendar's calendar list. Defaults to "slopcard agenda".
  calName?: string;
  // PRODID — identifier of the producing software, per RFC 5545 §3.7.3. The
  // default is informative; consumers don't validate it.
  prodId?: string;
}

const DEFAULT_PROD_ID = "-//slopcard//EAG agenda//EN";
const DEFAULT_CAL_NAME = "slopcard agenda";

// ── Escaping + folding helpers ───────────────────────────────────────────────

// RFC 5545 §3.3.11: TEXT values escape backslash, comma, semicolon, and
// newline. Order matters — escape backslashes FIRST so we don't double-escape
// the backslashes we introduce for commas/semicolons/newlines.
export function escapeIcsText(input: string): string {
  return input
    .replace(/\\/g, "\\\\")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

// RFC 5545 §3.1: lines longer than 75 octets must be split with CRLF + a
// single space (the space is the continuation marker, consumed by parsers).
// We count octets (UTF-8 byte length), not characters, because the spec is
// byte-bounded — a 75-char string of multi-byte glyphs would exceed the
// limit and trip strict parsers. Continuation chunks are 74 octets to leave
// room for the leading space on the next line.
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  const bytes = enc.encode(line);
  if (bytes.length <= 75) return line;

  // Walk the byte array and slice on byte boundaries. We then decode each
  // chunk back to a string. Decoding from a sliced byte array can split a
  // multi-byte sequence — we walk backwards to the nearest valid boundary
  // before cutting. TextDecoder with `fatal: false` would silently substitute
  // a replacement character; we avoid that by checking the high bits of the
  // last byte and pulling the slice back until we're on a code-point start.
  const chunks: string[] = [];
  let start = 0;
  const firstLimit = 75;
  const nextLimit = 74;
  while (start < bytes.length) {
    const isFirst = chunks.length === 0;
    const limit = isFirst ? firstLimit : nextLimit;
    let end = Math.min(start + limit, bytes.length);
    // Pull back to a UTF-8 code-point boundary. Continuation bytes have
    // the high bits 10xxxxxx (0x80–0xBF); if `end` lands on one we step
    // back until we don't.
    while (end > start && end < bytes.length) {
      const b = bytes[end];
      if ((b & 0xc0) !== 0x80) break;
      end -= 1;
    }
    chunks.push(new TextDecoder().decode(bytes.subarray(start, end)));
    start = end;
  }
  // Continuation marker is "\r\n " — a CRLF followed by a single space. The
  // emitter joins lines with CRLF separately, so we use the literal sequence
  // here to keep the contract local.
  return chunks.join("\r\n ");
}

// ── UTC formatting ───────────────────────────────────────────────────────────

// Convert an ISO 8601 string (with offset, as Swapcard returns) to the
// RFC 5545 UTC form "YYYYMMDDTHHMMSSZ". Date parsing handles the offset; we
// then format the UTC components manually so we don't depend on
// toISOString()'s exact output shape across runtimes.
export function toIcsUtc(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    throw new Error(`toIcsUtc: invalid ISO 8601 input: ${iso}`);
  }
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

// ── VEVENT + VCALENDAR builders ──────────────────────────────────────────────

function sessionDescription(session: ScrapedSession): string {
  // Plain-text description: categories joined + speaker names. Keeps the
  // export portable — htmlDescription is untrusted and would require a
  // sanitiser pass we haven't added yet.
  const parts: string[] = [];
  if (session.categories.length > 0) {
    parts.push(session.categories.map((c) => c.name).join(", "));
  }
  if (session.speakers.length > 0) {
    const names = session.speakers
      .map((s) => `${s.firstName} ${s.lastName}`.trim())
      .filter(Boolean);
    if (names.length > 0) parts.push(`speakers: ${names.join(", ")}`);
  }
  return parts.join("; ");
}

// Build the inner VEVENT lines for a single session. Caller is responsible
// for wrapping them in BEGIN:VCALENDAR/END:VCALENDAR. Lines are returned
// already folded; the caller joins on CRLF.
function buildVeventLines(session: ScrapedSession, dtstamp: string): string[] {
  const lines: string[] = [];
  lines.push("BEGIN:VEVENT");
  // UID must be globally unique; planningId is Swapcard's own id and we
  // suffix the slopcard domain so re-imports from different sources don't
  // alias to the same event in the calendar app.
  lines.push(foldLine(`UID:${session.planningId}@slopcard.org`));
  lines.push(`DTSTAMP:${dtstamp}`);
  lines.push(`DTSTART:${toIcsUtc(session.beginsAt)}`);
  lines.push(`DTEND:${toIcsUtc(session.endsAt)}`);
  lines.push(
    foldLine(`SUMMARY:${escapeIcsText(session.title || "(untitled session)")}`)
  );
  if (session.place) {
    lines.push(foldLine(`LOCATION:${escapeIcsText(session.place)}`));
  }
  const desc = sessionDescription(session);
  if (desc) {
    lines.push(foldLine(`DESCRIPTION:${escapeIcsText(desc)}`));
  }
  lines.push("END:VEVENT");
  return lines;
}

function calendarHeader(opts: IcsOptions | undefined): string[] {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${opts?.prodId ?? DEFAULT_PROD_ID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    foldLine(`X-WR-CALNAME:${escapeIcsText(opts?.calName ?? DEFAULT_CAL_NAME)}`),
  ];
}

// ── Public API ───────────────────────────────────────────────────────────────

// Emit a single-event VCALENDAR for one session. Convenience wrapper around
// sessionsToICSCalendar — useful for per-row "add to calendar" download
// buttons where wrapping one event in the full envelope keeps the response
// importable.
export function sessionToICS(
  session: ScrapedSession,
  opts?: IcsOptions
): string {
  return sessionsToICSCalendar([session], opts);
}

// Emit a VCALENDAR containing all the given sessions. Uses a single shared
// DTSTAMP for all events — RFC 5545 only requires DTSTAMP be the time the
// .ics was generated, not the time each event was created, so this matches
// the spec while keeping the export deterministic per request.
export function sessionsToICSCalendar(
  sessions: ScrapedSession[],
  opts?: IcsOptions
): string {
  // DTSTAMP is the moment we built the calendar. Subscribers re-fetch
  // periodically; each fetch produces a fresh stamp.
  const dtstamp = toIcsUtc(new Date().toISOString());
  const lines: string[] = [];
  lines.push(...calendarHeader(opts));
  for (const s of sessions) {
    lines.push(...buildVeventLines(s, dtstamp));
  }
  lines.push("END:VCALENDAR");
  // RFC 5545 line terminator is CRLF. A trailing CRLF after END:VCALENDAR
  // is permitted and some parsers expect it.
  return lines.join("\r\n") + "\r\n";
}
