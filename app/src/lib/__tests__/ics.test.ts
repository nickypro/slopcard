import { describe, it, expect } from "vitest";
import {
  escapeIcsText,
  foldLine,
  sessionToICS,
  sessionsToICSCalendar,
  toIcsUtc,
} from "@/lib/swapcard/ics";
import type { ScrapedSession } from "@/lib/swapcard/scrape-agenda-events";

// Minimal session builder — keeps tests focused on the ICS emitter shape
// rather than the (fully tested elsewhere) ScrapedSession round-trip.
function makeSession(
  overrides: Partial<ScrapedSession> &
    Pick<ScrapedSession, "planningId" | "beginsAt" | "endsAt">
): ScrapedSession {
  return {
    planningId: overrides.planningId,
    title: overrides.title ?? "Untitled",
    beginsAt: overrides.beginsAt,
    endsAt: overrides.endsAt,
    place: overrides.place ?? "",
    format: overrides.format ?? "PHYSICAL",
    categories: overrides.categories ?? [],
    description: overrides.description ?? "",
    maxSeats: overrides.maxSeats ?? null,
    remainingSeats: overrides.remainingSeats ?? null,
    visibility: overrides.visibility ?? "PUBLIC",
    speakers: overrides.speakers ?? [],
  };
}

describe("escapeIcsText", () => {
  it("escapes backslash first so subsequent escapes don't double-up", () => {
    expect(escapeIcsText("a\\b")).toBe("a\\\\b");
  });

  it("escapes commas and semicolons per RFC 5545", () => {
    expect(escapeIcsText("foo, bar; baz")).toBe("foo\\, bar\\; baz");
  });

  it("normalises CRLF and CR newlines to LF, then escapes to \\n", () => {
    expect(escapeIcsText("line1\r\nline2\rline3\nline4")).toBe(
      "line1\\nline2\\nline3\\nline4"
    );
  });

  it("handles all four escape classes simultaneously", () => {
    // \ , ; \n all in one input.
    const input = "path\\to;file, with\nnewline";
    expect(escapeIcsText(input)).toBe("path\\\\to\\;file\\, with\\nnewline");
  });
});

describe("foldLine", () => {
  it("returns short lines unchanged", () => {
    expect(foldLine("SHORT:ok")).toBe("SHORT:ok");
  });

  it("folds at 75 octets with CRLF + space continuation", () => {
    // 80-char ASCII title — each char is 1 octet, so folded after 75 bytes.
    const long = "SUMMARY:" + "x".repeat(80);
    const folded = foldLine(long);
    const lines = folded.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    // First line is exactly 75 octets.
    expect(new TextEncoder().encode(lines[0]).length).toBe(75);
    // Continuation lines start with a single space.
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i].startsWith(" ")).toBe(true);
    }
    // Round-trip: strip leading spaces on continuations → reconstruct
    // the original.
    const recon = lines
      .map((l, i) => (i === 0 ? l : l.slice(1)))
      .join("");
    expect(recon).toBe(long);
  });

  it("does not split a UTF-8 multi-byte sequence", () => {
    // Build a string where the natural cut at byte 75 would land in the
    // middle of a 3-byte codepoint. Use the snowman ☃ (U+2603, 3 bytes
    // in UTF-8). Prefix it with ASCII so the first chunk is forced past
    // the multibyte boundary.
    const prefix = "x".repeat(73);
    const long = prefix + "☃☃☃☃☃"; // 73 + 15 octets = 88
    const folded = foldLine(long);
    // Decode every chunk standalone — if we'd split a codepoint, we'd see
    // a U+FFFD replacement character somewhere.
    expect(folded).not.toContain("�");
  });
});

describe("toIcsUtc", () => {
  it("converts ISO-with-offset to UTC YYYYMMDDTHHMMSSZ", () => {
    // 09:00 +01:00 → 08:00 UTC.
    expect(toIcsUtc("2026-05-29T09:00:00+01:00")).toBe("20260529T080000Z");
  });

  it("handles UTC input (Z suffix) correctly", () => {
    expect(toIcsUtc("2026-05-29T09:00:00Z")).toBe("20260529T090000Z");
  });

  it("handles DST: Europe/London BST = +01:00, GMT = +00:00", () => {
    // 2026-03-29 02:00 BST is the spring-forward day; June is BST (+01:00).
    expect(toIcsUtc("2026-06-15T14:30:00+01:00")).toBe("20260615T133000Z");
    // November is GMT (+00:00).
    expect(toIcsUtc("2026-11-15T14:30:00+00:00")).toBe("20261115T143000Z");
  });

  it("pads single-digit month / day / hour / minute / second", () => {
    expect(toIcsUtc("2026-01-02T03:04:05Z")).toBe("20260102T030405Z");
  });

  it("throws on invalid input", () => {
    expect(() => toIcsUtc("not-a-date")).toThrow(/invalid ISO/);
  });
});

describe("sessionToICS — single session envelope", () => {
  it("emits a valid VCALENDAR with one VEVENT", () => {
    const s = makeSession({
      planningId: "P1",
      beginsAt: "2026-05-29T09:00:00+01:00",
      endsAt: "2026-05-29T10:00:00+01:00",
      title: "Opening Plenary",
      place: "Main Hall",
    });
    const ics = sessionToICS(s);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("END:VEVENT");
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("UID:P1@slopcard.org");
    expect(ics).toContain("DTSTART:20260529T080000Z");
    expect(ics).toContain("DTEND:20260529T090000Z");
    expect(ics).toContain("SUMMARY:Opening Plenary");
    expect(ics).toContain("LOCATION:Main Hall");
    // Final line terminator is CRLF.
    expect(ics.endsWith("\r\n")).toBe(true);
  });

  it("uses the custom calName / prodId when supplied", () => {
    const s = makeSession({
      planningId: "P1",
      beginsAt: "2026-05-29T09:00:00+01:00",
      endsAt: "2026-05-29T10:00:00+01:00",
    });
    const ics = sessionToICS(s, {
      calName: "EAG London picks",
      prodId: "-//test//test//EN",
    });
    expect(ics).toContain("PRODID:-//test//test//EN");
    expect(ics).toContain("X-WR-CALNAME:EAG London picks");
  });

  it("omits LOCATION when place is empty", () => {
    const s = makeSession({
      planningId: "P1",
      beginsAt: "2026-05-29T09:00:00+01:00",
      endsAt: "2026-05-29T10:00:00+01:00",
      place: "",
    });
    const ics = sessionToICS(s);
    expect(ics).not.toContain("LOCATION:");
  });

  it("falls back to '(untitled session)' when title is empty", () => {
    const s = makeSession({
      planningId: "P1",
      beginsAt: "2026-05-29T09:00:00+01:00",
      endsAt: "2026-05-29T10:00:00+01:00",
      title: "",
    });
    const ics = sessionToICS(s);
    expect(ics).toContain("SUMMARY:(untitled session)");
  });
});

describe("sessionToICS — escaping in real fields", () => {
  it("escapes commas / semicolons / newlines in title and place", () => {
    const s = makeSession({
      planningId: "P1",
      beginsAt: "2026-05-29T09:00:00+01:00",
      endsAt: "2026-05-29T10:00:00+01:00",
      title: "AI safety, ethics; alignment",
      place: "Room A,\nFloor 2",
    });
    const ics = sessionToICS(s);
    expect(ics).toContain("SUMMARY:AI safety\\, ethics\\; alignment");
    expect(ics).toContain("LOCATION:Room A\\,\\nFloor 2");
  });

  it("builds DESCRIPTION from categories + speakers", () => {
    const s = makeSession({
      planningId: "P1",
      beginsAt: "2026-05-29T09:00:00+01:00",
      endsAt: "2026-05-29T10:00:00+01:00",
      categories: [
        { id: "C1", name: "Plenary" },
        { id: "C2", name: "AI Safety" },
      ],
      speakers: [
        {
          eventPeopleId: "E1",
          firstName: "Alice",
          lastName: "Smith",
          organization: "Anthropic",
          photoUrl: null,
        },
        {
          eventPeopleId: "E2",
          firstName: "Bob",
          lastName: "Jones",
          organization: "",
          photoUrl: null,
        },
      ],
    });
    const ics = sessionToICS(s);
    // Commas inside the joined list get escaped; the inter-section
    // separator semicolon also gets escaped — both are spec-compliant.
    expect(ics).toContain(
      "DESCRIPTION:Plenary\\, AI Safety\\; speakers: Alice Smith\\, Bob Jones"
    );
  });

  it("omits DESCRIPTION when there are no categories or speakers", () => {
    const s = makeSession({
      planningId: "P1",
      beginsAt: "2026-05-29T09:00:00+01:00",
      endsAt: "2026-05-29T10:00:00+01:00",
    });
    const ics = sessionToICS(s);
    expect(ics).not.toContain("DESCRIPTION:");
  });
});

describe("sessionToICS — line folding for long titles", () => {
  it("folds the SUMMARY line at 75 octets", () => {
    const longTitle = "A".repeat(200);
    const s = makeSession({
      planningId: "P1",
      beginsAt: "2026-05-29T09:00:00+01:00",
      endsAt: "2026-05-29T10:00:00+01:00",
      title: longTitle,
    });
    const ics = sessionToICS(s);
    // The folded SUMMARY line should span multiple wire lines.
    const lines = ics.split("\r\n");
    const summaryIdx = lines.findIndex((l) => l.startsWith("SUMMARY:"));
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    // First SUMMARY line is at-or-under 75 octets.
    expect(new TextEncoder().encode(lines[summaryIdx]).length).toBeLessThanOrEqual(75);
    // Next line should be a continuation (starts with a space).
    expect(lines[summaryIdx + 1].startsWith(" ")).toBe(true);
  });
});

describe("sessionsToICSCalendar — multi-event calendar", () => {
  it("emits one envelope with all VEVENTs", () => {
    const sessions = [
      makeSession({
        planningId: "P1",
        beginsAt: "2026-05-29T09:00:00+01:00",
        endsAt: "2026-05-29T10:00:00+01:00",
        title: "First",
      }),
      makeSession({
        planningId: "P2",
        beginsAt: "2026-05-29T10:00:00+01:00",
        endsAt: "2026-05-29T11:00:00+01:00",
        title: "Second",
      }),
      makeSession({
        planningId: "P3",
        beginsAt: "2026-05-29T11:00:00+01:00",
        endsAt: "2026-05-29T12:00:00+01:00",
        title: "Third",
      }),
    ];
    const ics = sessionsToICSCalendar(sessions);
    const beginCount = ics.match(/BEGIN:VEVENT/g)?.length ?? 0;
    const endCount = ics.match(/END:VEVENT/g)?.length ?? 0;
    expect(beginCount).toBe(3);
    expect(endCount).toBe(3);
    // Single calendar envelope.
    expect(ics.match(/BEGIN:VCALENDAR/g)?.length).toBe(1);
    expect(ics.match(/END:VCALENDAR/g)?.length).toBe(1);
    expect(ics).toContain("SUMMARY:First");
    expect(ics).toContain("SUMMARY:Second");
    expect(ics).toContain("SUMMARY:Third");
  });

  it("emits an empty-but-valid calendar when given no sessions", () => {
    const ics = sessionsToICSCalendar([]);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("shares one DTSTAMP across all events in a single emit", () => {
    const sessions = [
      makeSession({
        planningId: "P1",
        beginsAt: "2026-05-29T09:00:00+01:00",
        endsAt: "2026-05-29T10:00:00+01:00",
      }),
      makeSession({
        planningId: "P2",
        beginsAt: "2026-05-29T10:00:00+01:00",
        endsAt: "2026-05-29T11:00:00+01:00",
      }),
    ];
    const ics = sessionsToICSCalendar(sessions);
    const stamps = ics.match(/DTSTAMP:[^\r\n]+/g) ?? [];
    expect(stamps.length).toBe(2);
    expect(stamps[0]).toBe(stamps[1]);
  });
});
