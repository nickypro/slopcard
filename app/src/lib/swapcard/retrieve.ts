// Hybrid retrieval: ranks every attendee by SEMANTIC similarity (cosine over
// local embeddings) and fuses that with BM25 ranks (via Reciprocal Rank
// Fusion, K=60). The semantic channel closes the vocabulary gap BM25 leaves
// — "talent scouting" matches "researcher identification" even with zero
// shared words. The BM25 channel hard-rewards exact-term hits on
// organisation/methodology names the LLM picked out.
//
// We run this twice: once for the primary "wanted" query/keywords, again for
// the off-axis "lateral" set with the primary pool subtracted. The lateral
// pool is what makes serendipitous picks real rather than "least-similar of
// the similar".
//
// Ported from kryjak/swapcard-meeting-tool (scripts/recall.ts + lib/retrieve.ts).

import MiniSearch from "minisearch";
import { bm25FitProfile } from "./embed-text";
import { cosine, embedOne } from "./embed";
import type { Attendee, Candidate } from "./types";

const RRF_K = 60;

// EA-jargon stopwords from the kryjak tool. Removing these stops BM25 from
// matching "AI" against every research profile and turning "impact research"
// into a coin flip. Adapt for non-EAG events.
const EXTRA_STOPWORDS = new Set([
  "ai", "the", "and", "or", "for", "to", "of", "a", "an", "in", "on", "with",
  "by", "as", "at", "is", "i", "we",
  "ea", "effective", "altruism", "altruist", "altruistic",
  "research", "researcher", "global", "impact",
  "work", "working", "experience", "people", "person",
  "help", "looking", "interested",
]);

const processTerm = (term: string): string | null => {
  const lower = term.toLowerCase();
  if (lower.length < 2) return null;
  if (EXTRA_STOPWORDS.has(lower)) return null;
  return lower;
};

interface IndexedDoc {
  id: string;
  fitProfile: string;
}

export interface AttendeeWithVector {
  attendee: Attendee;
  rowId: string; // stable retrieval id — personId if present, else "row:<n>"
  embedding: Float32Array;
  photoUrl: string | null;
}

// MiniSearch builds an in-memory inverted index. Build once per request from
// the snapshot the caller already pulled out of SQLite.
function buildIndex(rows: AttendeeWithVector[]): MiniSearch<IndexedDoc> {
  const index = new MiniSearch<IndexedDoc>({
    fields: ["fitProfile"],
    storeFields: ["id"],
    processTerm,
    searchOptions: {
      combineWith: "OR",
      prefix: true,
      fuzzy: 0.15,
      processTerm,
    },
  });
  index.addAll(
    rows.map((r) => ({ id: r.rowId, fitProfile: bm25FitProfile(r.attendee) }))
  );
  return index;
}

interface SemRank {
  rowId: string;
  sim: number;
}

function semanticRankAll(
  queryVec: Float32Array,
  rows: AttendeeWithVector[]
): SemRank[] {
  return rows
    .map((r) => ({ rowId: r.rowId, sim: cosine(queryVec, r.embedding) }))
    .sort((a, b) => b.sim - a.sim);
}

interface Scored {
  rowId: string;
  semRank?: number;
  bm25Rank?: number;
  score: number;
}

function rrfFuse(
  sem: SemRank[],
  bm25: { id: string }[],
  exclude: Set<string>,
  n: number
): Scored[] {
  const semRank = new Map(sem.map((x, i) => [x.rowId, i]));
  const bm25Rank = new Map(bm25.map((r, i) => [r.id, i]));
  const ids = new Set<string>([...semRank.keys(), ...bm25Rank.keys()]);
  const out: Scored[] = [];
  for (const id of ids) {
    if (exclude.has(id)) continue;
    const sr = semRank.get(id);
    const br = bm25Rank.get(id);
    let score = 0;
    if (sr !== undefined) score += 1 / (RRF_K + sr + 1);
    if (br !== undefined) score += 1 / (RRF_K + br + 1);
    out.push({ rowId: id, semRank: sr, bm25Rank: br, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, n);
}

export interface RetrieveInput {
  requesterRowId: string;
  rows: AttendeeWithVector[];
  semanticQuery: string;
  wantedKeywords: string[];
  lateralKeywords: string[];
  topPrimary?: number;
  topLateral?: number;
}

export interface RetrieveOutput {
  primary: Candidate[];
  lateral: Candidate[];
}

export async function retrieveCandidates(
  input: RetrieveInput
): Promise<RetrieveOutput> {
  const topPrimary = input.topPrimary ?? 150;
  const topLateral = input.topLateral ?? 40;
  const byRowId = new Map(input.rows.map((r) => [r.rowId, r]));

  const index = buildIndex(input.rows);

  // --- Primary pool: semantic(prose query) RRF BM25(wanted keywords) ---
  const qvec = await embedOne(input.semanticQuery || "conference attendee");
  const wantedQuery = input.wantedKeywords
    .map((k) => k.trim())
    .filter(Boolean)
    .join(" ");
  const primaryScored = rrfFuse(
    semanticRankAll(qvec, input.rows),
    wantedQuery ? index.search(wantedQuery, { fields: ["fitProfile"] }) : [],
    new Set([input.requesterRowId]),
    topPrimary
  );

  // --- Lateral pool: separate hybrid search, excluding primary ---
  const lateralQuery = input.lateralKeywords
    .map((k) => k.trim())
    .filter(Boolean);
  let lateralScored: Scored[] = [];
  if (lateralQuery.length) {
    const exclude = new Set<string>([
      input.requesterRowId,
      ...primaryScored.map((p) => p.rowId),
    ]);
    const lvec = await embedOne(lateralQuery.join(", "));
    lateralScored = rrfFuse(
      semanticRankAll(lvec, input.rows),
      index.search(lateralQuery.join(" "), { fields: ["fitProfile"] }),
      exclude,
      topLateral
    );
  }

  const toCandidate =
    (pool: "primary" | "lateral") =>
    (s: Scored): Candidate | null => {
      const row = byRowId.get(s.rowId);
      if (!row) return null;
      return {
        attendee: row.attendee,
        photoUrl: row.photoUrl,
        pool,
        semRank: s.semRank,
        bm25Rank: s.bm25Rank,
        score: s.score,
      };
    };

  return {
    primary: primaryScored
      .map(toCandidate("primary"))
      .filter((c): c is Candidate => c !== null),
    lateral: lateralScored
      .map(toCandidate("lateral"))
      .filter((c): c is Candidate => c !== null),
  };
}
