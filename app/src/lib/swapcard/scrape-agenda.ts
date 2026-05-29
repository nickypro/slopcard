// Authenticated scrape of Swapcard's per-attendee available meeting slots.
// Used by /discover to flag schedule conflicts and to surface "N free slots"
// badges next to candidates. The same bearer JWT that powers
// scrape-attendees.ts works here — TTL ~24h, not persisted.
//
// Swapcard returns slots per personId, so kryjak's reference tool fires one
// MeetSlotsQuery per attendee in parallel. We mirror that with a bounded
// worker pool (default cap of 5; kryjak uses 8 but we stay conservative to
// keep the admin worker friendly). Both CommunityProfile_<n> and
// EventPeople_<n> IDs are accepted by Swapcard's resolver.
//
// Wire format + persisted-query hash extracted from a real Swapcard session
// HAR. If Swapcard rotates the hash this throws a PERSISTED_QUERY_NOT_FOUND
// error that aborts the whole batch — every personId would fail the same way,
// so there's no value in continuing.

const GRAPHQL_URL = "https://app.swapcard.com/api/graphql";
const OPERATION_NAME = "MeetSlotsQuery";
const PERSISTED_HASH =
  "8be60e0a3635c30fe5574b3a33c4434c22bf6671194c419496f84de47dbae13c";

// Matches kryjak's pageSize; Swapcard returns up to this many slots in one
// shot, which comfortably covers a 4-day conference at 15-min granularity.
const DEFAULT_FIRST = 1152;

export interface MeetSlot {
  id: string;
  starts: string; // ISO 8601 with offset, exactly as Swapcard returns
  ends: string;
}

export interface MeetSlotsResult {
  peopleId: string;
  slots: MeetSlot[];
}

interface GraphQLNode {
  id?: string;
  starts?: string;
  ends?: string;
}

interface GraphQLResponse {
  data?: {
    event?: {
      availableMeetingSlots?: {
        nodes?: GraphQLNode[];
      };
    };
  };
  errors?: { message: string; extensions?: { code?: string } }[];
}

export async function fetchMeetSlotsBatch(opts: {
  bearerToken: string;
  eventId: string;
  peopleIds: string[];
  dateRange: { start: string; end: string };
  concurrency?: number;
  perRequestTimeoutMs?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<MeetSlotsResult[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 5);
  const perRequestTimeoutMs = opts.perRequestTimeoutMs ?? 15000;
  const headers: Record<string, string> = {
    accept: "*/*",
    "content-type": "application/json",
    authorization: opts.bearerToken.startsWith("Bearer ")
      ? opts.bearerToken
      : `Bearer ${opts.bearerToken}`,
    "x-client-origin": "app.swapcard.com",
    "x-client-platform": "Event App",
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  };

  const total = opts.peopleIds.length;
  const results: MeetSlotsResult[] = new Array(total);
  let nextIndex = 0;
  let done = 0;
  // Sentinel: when set, all in-flight workers stop pulling new work. We use
  // this to propagate a PERSISTED_QUERY_NOT_FOUND failure (hash rotated → no
  // point asking N more times).
  let abortError: Error | null = null;

  const fetchOne = async (peopleId: string): Promise<MeetSlotsResult> => {
    // Per-request body is the Swapcard "batched" array — even with one op the
    // server expects an array and `r.json()[0]` is the entry we care about.
    const body = [
      {
        operationName: OPERATION_NAME,
        variables: {
          eventId: opts.eventId,
          peopleIds: [peopleId],
          exhibitorIds: [],
          dateRange: { start: opts.dateRange.start, end: opts.dateRange.end },
          first: DEFAULT_FIRST,
        },
        extensions: {
          persistedQuery: { version: 1, sha256Hash: PERSISTED_HASH },
        },
      },
    ];

    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(perRequestTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(
        `Swapcard MeetSlotsQuery HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`
      );
    }
    const parsed = (await res.json()) as GraphQLResponse[];
    const entry = parsed?.[0];
    if (!entry) {
      throw new Error(
        `Unexpected MeetSlotsQuery response shape: ${JSON.stringify(parsed).slice(0, 300)}`
      );
    }
    const code = entry.errors?.[0]?.extensions?.code;
    if (code === "PERSISTED_QUERY_NOT_FOUND") {
      throw new Error(
        "PERSISTED_QUERY_NOT_FOUND — Swapcard rotated the MeetSlotsQuery hash. Re-export a HAR and update PERSISTED_HASH (hash rotation)."
      );
    }
    if (entry.errors?.length) {
      throw new Error(
        `Swapcard MeetSlotsQuery GraphQL errors: ${entry.errors.map((e) => e.message).join("; ")}`
      );
    }
    const nodes = entry.data?.event?.availableMeetingSlots?.nodes ?? [];
    const slots: MeetSlot[] = [];
    for (const n of nodes) {
      if (!n.id || !n.starts || !n.ends) continue;
      slots.push({ id: n.id, starts: n.starts, ends: n.ends });
    }
    return { peopleId, slots };
  };

  const worker = async () => {
    while (true) {
      if (abortError) return;
      const i = nextIndex++;
      if (i >= total) return;
      const peopleId = opts.peopleIds[i];
      try {
        results[i] = await fetchOne(peopleId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Hash-rotation: every personId would fail the same way, abort batch.
        if (msg.includes("PERSISTED_QUERY_NOT_FOUND")) {
          abortError = err instanceof Error ? err : new Error(msg);
          return;
        }
        // Auth failures shouldn't be silently swallowed into per-person
        // empty-slots; the caller needs to know to refresh the token.
        if (/HTTP 401\b/.test(msg) || /HTTP 403\b/.test(msg)) {
          abortError = err instanceof Error ? err : new Error(msg);
          return;
        }
        console.warn(
          `[scrape-agenda] peopleId=${peopleId} failed, returning empty slots: ${msg}`
        );
        results[i] = { peopleId, slots: [] };
      } finally {
        done += 1;
        opts.onProgress?.(done, total);
      }
    }
  };

  const pool = Array.from({ length: Math.min(concurrency, total) }, () =>
    worker()
  );
  await Promise.all(pool);

  if (abortError) throw abortError;
  return results;
}
