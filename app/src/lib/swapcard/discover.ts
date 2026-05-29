// /discover orchestrator. Loads the cached attendee snapshot for an event,
// makes two LLM calls (query construction → ranking), with retrieval in
// between, and persists the resulting run keyed by (handle, sheet_signature).
// Re-running on the same sheet snapshot is cheap (cache hit); a sheet refresh
// invalidates the cache automatically because the signature changes.

import {
  getLatestDiscoverRun,
  insertDiscoverRun,
  listSwapcardAttendees,
  getSheetSignature,
  updateDiscoverRunPayload,
  getSwapcardAttendeeByAnyId,
  listFreshAttendeeSlotCounts,
} from "../db";
import { blobToVector } from "./embed";
import { profileForLlm } from "./embed-text";
import { callLlmJson } from "./llm";
import { isLinkedinUrl, isSwapcardProfileUrl } from "./parse-url";
import { QUERY_SYSTEM, recsSystem } from "./prompts";
import { retrieveCandidates, type AttendeeWithVector } from "./retrieve";
import type {
  Attendee,
  Candidate,
  DiscoverRun,
  Recommendation,
  RetrievedCandidate,
  SearchQuery,
} from "./types";

const NUM_RECOMMENDATIONS = 25;
const TOP_PRIMARY = 150;
const TOP_LATERAL = 40;

// Raw LLM output shape — shaped after kryjak's prompts. We coerce + validate
// before saving so a flaky model can't corrupt the cache.
interface RawRecommendation {
  name?: string;
  role?: string;
  company?: string;
  country?: string;
  rating?: number | string;
  why?: string;
  talking_points?: string[];
  suggested_opener?: string;
}

export type DiscoverPhase =
  | "starting"
  | "cached"
  | "loading_attendees"
  | "building_query"
  | "vectorising"
  | "retrieving"
  | "ranking"
  | "saving"
  | "done";

export interface DiscoverPhaseEvent {
  phase: DiscoverPhase;
  meta?: Record<string, unknown>;
}

export interface DiscoverInput {
  handle: string;
  requester: Attendee;
  requesterPersonId: string;
  eventId: string;
  extraContext: string;
  goals: string;
  // Free-form prompt the user can paste into the UI — surfaces alongside
  // their sheet bio in the requester context so the LLM uses both.
  customPrompt?: string;
  // OpenRouter key. When unset, llm.ts falls back to OPENROUTER_API_KEY.
  apiKey?: string;
  refresh?: boolean;
  // Drops the upstream LLM calls if the client disconnects mid-stream.
  signal?: AbortSignal;
  onPhase?: (event: DiscoverPhaseEvent) => void;
}

export async function runDiscover(input: DiscoverInput): Promise<DiscoverRun> {
  const phase = (p: DiscoverPhase, meta?: Record<string, unknown>) =>
    input.onPhase?.({ phase: p, meta });
  phase("starting");
  const sig = getSheetSignature(input.eventId);
  if (!sig) {
    throw new Error(
      "No attendee data ingested for this event yet — run the admin ingest first."
    );
  }

  if (!input.refresh) {
    const cached = getLatestDiscoverRun(input.handle, input.eventId, sig);
    if (cached) {
      phase("cached");
      return JSON.parse(cached.payloadJson) as DiscoverRun;
    }
  }

  // Pull every attendee for this event in one query, decode the embedding blobs.
  phase("loading_attendees");
  const dbRows = listSwapcardAttendees(input.eventId);
  if (dbRows.length === 0) throw new Error("Attendee cache is empty");
  // rowId is the stable identity for retrieval — prefers person_id (sheet's
  // canonical key) but falls back to event_people_id for stub rows that have
  // no sheet entry. Same precedence as the link route uses when picking the
  // canonical ID to store on the card, so requester exclusion matches up.
  const rows: AttendeeWithVector[] = dbRows.map((r, idx) => ({
    attendee: JSON.parse(r.profileJson) as Attendee,
    rowId: r.personId ?? r.eventPeopleId ?? `row:${idx}`,
    embedding: blobToVector(r.embedding),
    photoUrl: r.photoUrl,
  }));
  const requesterRowId = input.requesterPersonId;

  // --- LLM call 1: build query + keyword lists ---
  phase("building_query");
  const requesterContext = profileForLlm(input.requester);
  const customPromptTrimmed = input.customPrompt?.trim() ?? "";

  // The customPrompt is treated as an explicit OVERRIDE on top of the
  // requester's profile-inferred interests. Without this priority framing
  // the LLM weights the bio more than the prompt — e.g. an AI-safety bio
  // + "find me animal welfare people" returned mostly AI safety candidates
  // because both go through query construction as equal-weight context.
  const overrideBlock = customPromptTrimmed
    ? [
        `### PRIORITY DIRECTIVE (must dominate the query) ###`,
        customPromptTrimmed,
        `### END PRIORITY DIRECTIVE ###`,
        `The requester's profile below is CONTEXT for who they are, but the`,
        `priority directive above is what they want to find. When the two`,
        `conflict (e.g. their bio says X but they're asking for Y people),`,
        `the directive wins. Build keywords and prose query to surface Y, not X.`,
      ].join("\n")
    : "";

  const queryUser = [
    overrideBlock,
    `Requester profile:\n${requesterContext}`,
    `Additional context:\n${input.extraContext || "(none provided)"}`,
    `Conference goals:\n${input.goals || "(none provided)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  // Reasoning-style models (gemini-3.5-flash, deepseek-v4-pro) can burn lots
  // of internal tokens before output; the budget here is mostly safety belt
  // since deepseek-v4-pro doesn't share thinking/output budget.
  const queryData = await callLlmJson<{
    query?: string;
    wanted?: string[];
    lateral?: string[];
  }>({
    system: QUERY_SYSTEM,
    user: queryUser,
    maxTokens: 16384,
    apiKey: input.apiKey,
    signal: input.signal,
  });

  const searchQuery: SearchQuery = {
    query: String(queryData.query ?? "").slice(0, 4000),
    wanted: Array.isArray(queryData.wanted) ? queryData.wanted.filter(isShortStr) : [],
    lateral: Array.isArray(queryData.lateral)
      ? queryData.lateral.filter(isShortStr)
      : [],
  };

  // --- Retrieval: vectorise the query then hybrid (semantic + BM25) RRF ---
  phase("vectorising", {
    wantedKeywords: searchQuery.wanted.length,
    lateralKeywords: searchQuery.lateral.length,
  });
  // (the embed of the query happens inside retrieveCandidates; we just
  // surface a separate "vectorising" event so the UI can show it as a step.)
  phase("retrieving", { totalAttendees: rows.length });
  const retrieved = await retrieveCandidates({
    requesterRowId,
    rows,
    semanticQuery: searchQuery.query,
    wantedKeywords: searchQuery.wanted,
    lateralKeywords: searchQuery.lateral,
    topPrimary: TOP_PRIMARY,
    topLateral: TOP_LATERAL,
  });

  // --- LLM call 2: rank + describe ---
  phase("ranking", {
    primary: retrieved.primary.length,
    lateral: retrieved.lateral.length,
    asking: NUM_RECOMMENDATIONS,
  });
  const candidateBlocks = [...retrieved.primary, ...retrieved.lateral].map(
    (c) => `[${c.pool}]\n${profileForLlm(c.attendee)}`
  );
  // Same priority framing on the ranking call — without it the ranker still
  // re-weights based on profile-aligned candidates that retrieval surfaced,
  // even if the directive said otherwise.
  const recsUser = [
    overrideBlock,
    `Requester profile:\n${requesterContext}`,
    `Requester's additional context:\n${input.extraContext || "(none provided)"}`,
    `Requester's conference goals:\n${input.goals || "(none provided)"}`,
    `Retrieved candidates (${candidateBlocks.length} total; [primary] = strong match, [lateral] = serendipitous):\n\n` +
      candidateBlocks.join("\n\n---\n\n"),
  ]
    .filter(Boolean)
    .join("\n\n");

  // Output budget covers 25 recs × ~400 tokens; reasoning-model headroom is
  // intentionally generous.
  const rawRecs = await callLlmJson<{ recommendations?: RawRecommendation[] }>({
    system: recsSystem(NUM_RECOMMENDATIONS),
    user: recsUser,
    maxTokens: 65536,
    apiKey: input.apiKey,
    signal: input.signal,
  });
  const candidateByName = indexByName([...retrieved.primary, ...retrieved.lateral]);
  const recommendations = (rawRecs.recommendations ?? [])
    .map((r) => normaliseRec(r, candidateByName))
    .filter((r): r is Recommendation => r !== null);

  // Annotate recs with cached available-slot counts. The cache is keyed by
  // event_people_id (EventPeople_<n>) but rec.personId is the
  // CommunityProfile_<n> from the sheet, so we walk through
  // swapcard_attendees to bridge the two ID schemes. Slot annotation should
  // never fail a discover run — wrap the whole thing in a try and fall back
  // to null on any error. 15-min TTL matches the admin-refresh cadence we
  // document on the badge tooltip.
  try {
    const personIdToEventPeopleId = new Map<string, string>();
    for (const rec of recommendations) {
      if (!rec.personId || personIdToEventPeopleId.has(rec.personId)) continue;
      const attendee = getSwapcardAttendeeByAnyId(input.eventId, rec.personId);
      if (attendee?.eventPeopleId) {
        personIdToEventPeopleId.set(rec.personId, attendee.eventPeopleId);
      }
    }
    const eventPeopleIds = Array.from(new Set(personIdToEventPeopleId.values()));
    const counts = listFreshAttendeeSlotCounts(input.eventId, eventPeopleIds, 900);
    for (const rec of recommendations) {
      const epid = rec.personId
        ? personIdToEventPeopleId.get(rec.personId)
        : undefined;
      rec.freeSlotCount = epid && counts.has(epid) ? counts.get(epid)! : null;
    }
  } catch (err) {
    console.warn(
      `[discover] slot annotation failed, leaving counts null: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    for (const rec of recommendations) rec.freeSlotCount = null;
  }

  const run: DiscoverRun = {
    generatedAt: Date.now(),
    sheetSignature: sig,
    totalAttendees: rows.length,
    primaryRetrieved: retrieved.primary.length,
    lateralRetrieved: retrieved.lateral.length,
    searchQuery,
    recommendations,
    retrieved: {
      primary: retrieved.primary.map(toRetrievedCandidate),
      lateral: retrieved.lateral.map(toRetrievedCandidate),
    },
  };
  phase("saving", { picks: recommendations.length });
  // Insert first to capture the row id, then stamp it onto the payload and
  // rewrite the row so the cached JSON echoes its own id. Two writes keeps
  // the orchestrator from having to predict the next AUTOINCREMENT.
  const runId = insertDiscoverRun(
    input.handle,
    input.eventId,
    sig,
    JSON.stringify(run)
  );
  run.runId = runId;
  updateDiscoverRunPayload(runId, JSON.stringify(run));
  phase("done");
  return run;
}

const isShortStr = (x: unknown): x is string =>
  typeof x === "string" && x.trim().length > 0 && x.length < 100;

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

function indexByName(candidates: Candidate[]): Map<string, Candidate> {
  const m = new Map<string, Candidate>();
  for (const c of candidates) {
    const key = `${c.attendee.firstName} ${c.attendee.lastName}`
      .trim()
      .toLowerCase();
    if (key && !m.has(key)) m.set(key, c);
  }
  return m;
}

// Coerce a raw LLM rec into the validated shape. We cross-reference the
// candidate pool by name to recover the canonical Swapcard URL + person_id +
// pool tag rather than trusting the model to echo them back exactly.
function normaliseRec(
  raw: RawRecommendation,
  byName: Map<string, Candidate>
): Recommendation | null {
  if (!raw || typeof raw.name !== "string" || !raw.name.trim()) return null;
  const rating = Math.max(1, Math.min(5, Math.round(Number(raw.rating ?? 3))));
  if (!Number.isFinite(rating)) return null;
  const key = raw.name.trim().toLowerCase();
  const match = byName.get(key);
  // Re-validate the sheet-sourced URLs before they reach a rendered `<a href>`.
  // The sheet ingest already filters these, but old DB rows from before the
  // filter shipped still have raw values; the runtime guard keeps those safe
  // and is cheap (just a `new URL` + host check).
  const rawSwapcardUrl = match?.attendee.swapcardUrl ?? "";
  const safeSwapcardUrl = isSwapcardProfileUrl(rawSwapcardUrl)
    ? rawSwapcardUrl
    : "";
  const rawLinkedinUrl = match?.attendee.linkedinUrl ?? "";
  const safeLinkedinUrl = isLinkedinUrl(rawLinkedinUrl) ? rawLinkedinUrl : "";
  return {
    personId: match?.attendee.personId ?? null,
    name: raw.name.trim(),
    role: String(raw.role ?? "").trim(),
    company: String(raw.company ?? match?.attendee.company ?? "").trim(),
    country: String(raw.country ?? match?.attendee.country ?? "").trim(),
    rating,
    why: String(raw.why ?? "").trim(),
    talkingPoints: Array.isArray(raw.talking_points)
      ? raw.talking_points.filter((t) => typeof t === "string").slice(0, 5)
      : [],
    suggestedOpener: String(raw.suggested_opener ?? "").trim(),
    swapcardUrl: safeSwapcardUrl,
    linkedinUrl: safeLinkedinUrl,
    photoUrl: match?.photoUrl ?? null,
    pool: match?.pool ?? "primary",
  };
}
