// Free vector-only discover tier. Mirrors `runDiscover` but skips both LLM
// calls: the requester's own profile text drives the semantic query and the
// expertise/interests tags drive the BM25 channel. No ranking, no rationales,
// no DB persistence — these runs are cheap to regenerate so they don't need
// to live in `swapcard_discover_runs`.
//
// Lateral keywords are intentionally empty: the "wildcard" pool is an LLM
// concept (the model picks off-axis keywords to widen the funnel). Without a
// model we'd be inventing serendipity by picking random tokens, which is
// worse than just not having it.

import { listSwapcardAttendees, getSheetSignature } from "../db";
import { blobToVector } from "./embed";
import { retrieveCandidates, type AttendeeWithVector } from "./retrieve";
import type {
  Attendee,
  Candidate,
  DiscoverRun,
  RetrievedCandidate,
  SearchQuery,
} from "./types";
import { isSwapcardProfileUrl } from "./parse-url";

const DEFAULT_TOP_PRIMARY = 50;
// Cap on combined wanted-keywords list. Past ~30 the BM25 channel becomes a
// soup of every tag the requester ever picked and stops discriminating.
const MAX_WANTED_KEYWORDS = 30;

export interface VectorDiscoverInput {
  requester: Attendee;
  requesterPersonId: string;
  eventId: string;
  customPrompt?: string;
  goals: string; // typically card.description
  topPrimary?: number; // default 50
}

export async function runVectorOnlyDiscover(
  input: VectorDiscoverInput
): Promise<DiscoverRun> {
  const sig = getSheetSignature(input.eventId);
  if (!sig) {
    throw new Error(
      "No attendee data ingested for this event yet — run the admin ingest first."
    );
  }

  const dbRows = listSwapcardAttendees(input.eventId);
  if (dbRows.length === 0) throw new Error("Attendee cache is empty");
  const rows: AttendeeWithVector[] = dbRows.map((r, idx) => ({
    attendee: JSON.parse(r.profileJson) as Attendee,
    rowId: r.personId ?? r.eventPeopleId ?? `row:${idx}`,
    embedding: blobToVector(r.embedding),
    photoUrl: r.photoUrl,
  }));

  // Build the prose query from the requester's own context. Falls back to a
  // bare name/role string when bio/goals/prompt are all empty so retrieve's
  // semantic channel still has something non-empty to embed (otherwise it
  // would embed the literal "conference attendee" default and rank by noise).
  const requester = input.requester;
  const queryParts = [
    requester.biography?.trim(),
    input.goals?.trim(),
    input.customPrompt?.trim(),
  ].filter((s): s is string => !!s && s.length > 0);
  const query = queryParts.length
    ? queryParts.join("\n\n")
    : [
        requester.firstName,
        requester.lastName,
        requester.jobTitle,
        requester.company,
      ]
        .filter(Boolean)
        .join(" ")
        .trim();

  // Dedupe is case-insensitive but preserves the original casing of the first
  // occurrence — keeps acronyms like "ML" rendering correctly if they survive
  // the retrieve.ts stopword filter.
  const wantedKeywords = dedupeAndCap(
    [...(requester.expertise ?? []), ...(requester.interests ?? [])]
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter(Boolean),
    MAX_WANTED_KEYWORDS
  );

  const searchQuery: SearchQuery = {
    query,
    wanted: wantedKeywords,
    lateral: [],
  };

  const retrieved = await retrieveCandidates({
    requesterRowId: input.requesterPersonId,
    rows,
    semanticQuery: query,
    wantedKeywords,
    lateralKeywords: [],
    topPrimary: input.topPrimary ?? DEFAULT_TOP_PRIMARY,
    topLateral: 0,
  });

  return {
    // runId intentionally undefined: vector-tier runs are not persisted.
    runId: undefined,
    generatedAt: Date.now(),
    sheetSignature: sig,
    totalAttendees: rows.length,
    primaryRetrieved: retrieved.primary.length,
    lateralRetrieved: 0,
    searchQuery,
    recommendations: [],
    retrieved: {
      primary: retrieved.primary.map(toRetrievedCandidate),
      lateral: [],
    },
  };
}

function dedupeAndCap(items: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

// Same shape and URL-sanitization rules as discover.ts so the UI can render
// either tier's `retrieved.primary` without branching.
function toRetrievedCandidate(c: Candidate): RetrievedCandidate {
  const a = c.attendee;
  return {
    personId: a.personId,
    eventPeopleId: null,
    name: `${a.firstName} ${a.lastName}`.trim(),
    role: a.jobTitle,
    company: a.company,
    country: a.country,
    photoUrl: c.photoUrl,
    swapcardUrl: isSwapcardProfileUrl(a.swapcardUrl) ? a.swapcardUrl : "",
    semRank: c.semRank ?? null,
    bm25Rank: c.bm25Rank ?? null,
    score: Number(c.score.toFixed(5)),
  };
}
