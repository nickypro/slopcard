// Fetches and parses the public EAG attendee Google Sheet, returning a stable
// in-memory shape. Lifted from the kryjak tool's column layout. The fetch is
// HTTP-only (no auth needed — the sheet is public CSV export) and gets cached
// at the caller level by the DB ingest layer.

import Papa from "papaparse";
import { isLinkedinUrl, parseSwapcardUrl } from "./parse-url";
import type { Attendee } from "./types";

const DEFAULT_SHEET_ID = "1Uvj0sDZzQJN0gUsccpw0HAf5qjFB6pkbjGMt2QuH6RA";
const DEFAULT_SHEET_GID = "43679916";
const DEFAULT_EVENT_ID = "eag-london-2026";
const HEADER_FIRST_CELL = "First Name";

const splitList = (s: string | undefined): string[] => {
  if (!s) return [];
  return s
    .split(/;|\n/)
    .map((x) => x.trim())
    .filter(Boolean);
};

// Heuristic from the kryjak tool: when two rows resolve to the same identity,
// pick the more fleshed-out one. Cheap proxy for "real profile vs. stub".
const richness = (a: Attendee): number =>
  (a.biography?.length ?? 0) +
  (a.needHelp?.length ?? 0) +
  (a.helpOthers?.length ?? 0) +
  a.expertise.length * 10 +
  a.interests.length * 10;

export interface SheetFetchResult {
  eventId: string;
  attendees: Attendee[];
  fetchedAt: number;
}

export async function fetchAttendeeSheet(opts?: {
  sheetId?: string;
  sheetGid?: string;
  eventId?: string;
}): Promise<SheetFetchResult> {
  const sheetId = opts?.sheetId ?? process.env.SWAPCARD_SHEET_ID ?? DEFAULT_SHEET_ID;
  const sheetGid = opts?.sheetGid ?? process.env.SWAPCARD_SHEET_GID ?? DEFAULT_SHEET_GID;
  const eventId = opts?.eventId ?? process.env.SWAPCARD_EVENT_ID ?? DEFAULT_EVENT_ID;

  const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${sheetGid}`;
  const res = await fetch(csvUrl);
  if (!res.ok) {
    throw new Error(`Sheet fetch failed: ${res.status}`);
  }
  const text = await res.text();
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false });
  const rows = parsed.data;
  const headerIdx = rows.findIndex(
    (r) => Array.isArray(r) && r[0]?.trim() === HEADER_FIRST_CELL
  );
  if (headerIdx < 0) {
    throw new Error("Could not find header row in sheet");
  }

  const dataRows = rows.slice(headerIdx + 1);
  const attendees: Attendee[] = [];
  for (const row of dataRows) {
    if (!Array.isArray(row) || row.every((c) => !c?.trim())) continue;
    const firstName = row[0]?.trim() ?? "";
    const lastName = row[1]?.trim() ?? "";
    if (!firstName && !lastName) continue;
    const rawSwapcardUrl = row[13]?.trim() ?? "";
    const parsed = rawSwapcardUrl ? parseSwapcardUrl(rawSwapcardUrl) : null;
    // Only persist URLs that pass strict validation. The sheet column is a
    // free-text field on the public EAG form; an attacker can drop a
    // phishing URL in their own row and otherwise have it rendered as a
    // "Swapcard profile" link in other attendees' /discover output.
    const swapcardUrl = parsed ? rawSwapcardUrl : "";
    const rawLinkedinUrl = row[14]?.trim() ?? "";
    const linkedinUrl = isLinkedinUrl(rawLinkedinUrl) ? rawLinkedinUrl : "";
    const a: Attendee = {
      eventId,
      personId: parsed?.personId ?? null,
      firstName,
      lastName,
      company: row[2]?.trim() ?? "",
      jobTitle: row[3]?.trim() ?? "",
      careerStage: row[4]?.trim() ?? "",
      biography: row[5]?.trim() ?? "",
      expertise: splitList(row[6]),
      interests: splitList(row[7]),
      needHelp: row[8]?.trim() ?? "",
      helpOthers: row[9]?.trim() ?? "",
      country: row[10]?.trim() ?? "",
      seekingWork: row[11]?.trim() ?? "",
      recruitment: splitList(row[12]),
      swapcardUrl,
      linkedinUrl,
    };
    if (!hasAnyContent(a)) continue;
    attendees.push(a);
  }

  return { eventId, attendees: dedupe(attendees), fetchedAt: Date.now() };
}

const hasAnyContent = (a: Attendee): boolean =>
  !!(
    a.biography ||
    a.expertise.length ||
    a.interests.length ||
    a.helpOthers ||
    a.needHelp ||
    a.jobTitle ||
    a.company
  );

// Dedupe by personId where present (Swapcard guarantees this is unique).
// Rows without a personId are deduped by (firstName, lastName, company),
// which is a softer key — false collisions are possible but rare and the
// fallback is just "richer entry wins" anyway.
function dedupe(attendees: Attendee[]): Attendee[] {
  const byKey = new Map<string, Attendee>();
  for (const a of attendees) {
    const key = a.personId
      ? `pid:${a.personId}`
      : `name:${a.firstName}|${a.lastName}|${a.company}`.toLowerCase();
    const existing = byKey.get(key);
    if (!existing || richness(a) > richness(existing)) {
      byKey.set(key, a);
    }
  }
  return [...byKey.values()];
}
