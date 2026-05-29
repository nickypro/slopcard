// Shape of one parsed row from the EAG attendee sheet. Mirrors the kryjak
// tool's column layout — see the EA Global London 2026 sheet for the source
// of truth on column order. `personId` is the base64 Swapcard EventPeople ID
// extracted from `swapcardUrl` when present; absent when the attendee chose
// not to share a Swapcard link.

export interface Attendee {
  eventId: string;
  personId: string | null;
  firstName: string;
  lastName: string;
  company: string;
  jobTitle: string;
  careerStage: string;
  biography: string;
  expertise: string[];
  interests: string[];
  needHelp: string;
  helpOthers: string;
  country: string;
  seekingWork: string;
  recruitment: string[];
  swapcardUrl: string;
  linkedinUrl: string;
}

// One candidate as it flows through retrieval → LLM ranking. photoUrl rides
// alongside the Attendee so the UI can render avatars without re-querying
// the DB row.
export interface Candidate {
  attendee: Attendee;
  photoUrl: string | null;
  pool: "primary" | "lateral";
  semRank?: number;
  bm25Rank?: number;
  score: number;
}

// The structured JSON returned by the query-construction LLM call.
export interface SearchQuery {
  query: string;
  wanted: string[];
  lateral: string[];
}

// One pick returned by the ranking LLM call. Fields mirror kryjak's prompt
// schema; we keep `swapcardUrl` server-side rather than trusting the LLM to
// echo the right one.
export interface Recommendation {
  personId: string | null;
  name: string;
  role: string;
  company: string;
  country: string;
  rating: number; // 1-5
  why: string;
  talkingPoints: string[];
  suggestedOpener: string;
  swapcardUrl: string;
  linkedinUrl: string;
  photoUrl: string | null;
  pool: "primary" | "lateral";
  // Cached "available 30-min meeting slots" count from the agenda scrape.
  // null = no cache row (unknown — admin hasn't refreshed yet, or attendee
  // has no event_people_id mapping). 0 = cached but no free overlap.
  // >0 = cached with that many open slots. Optional on the type so runs
  // serialised before iter-14 deserialise cleanly.
  freeSlotCount?: number | null;
}

// Compact view of a retrieved candidate — what was kept after RRF fusion, in
// rank order, with sem/bm25 ranks for transparency. The full Attendee
// object is intentionally NOT inlined here; we keep what's needed to render
// a list and link out without bloating the cached payload to ~MB per run.
export interface RetrievedCandidate {
  personId: string | null;
  eventPeopleId: string | null;
  name: string;
  role: string;
  company: string;
  country: string;
  photoUrl: string | null;
  swapcardUrl: string;
  semRank: number | null;
  bm25Rank: number | null;
  score: number;
}

export interface DiscoverRun {
  // The row id from swapcard_discover_runs. Optional because runs cached
  // before this field shipped don't have it, and the share-link button hides
  // gracefully when absent. New runs always carry it.
  runId?: number;
  generatedAt: number;
  sheetSignature: string;
  totalAttendees: number;
  primaryRetrieved: number;
  lateralRetrieved: number;
  searchQuery: SearchQuery;
  recommendations: Recommendation[];
  // The raw retrieval output before the LLM ranking layer. Toggleable in the
  // UI so users can browse the wider candidate pool instead of just the
  // 25 picks the LLM chose. Cheap to render (~200 rows).
  retrieved: {
    primary: RetrievedCandidate[];
    lateral: RetrievedCandidate[];
  };
}
