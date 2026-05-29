// Authenticated scrape of Swapcard's GENERAL event agenda — talks, plenaries,
// workshops. Distinct from scrape-agenda.ts (which fetches per-attendee free
// meeting slots) and from scrape-attendees.ts (which fetches the people list).
// Mirrors the patterns in those two: same bearer JWT (TTL ~24h, never
// persisted), same headers, same batched-array request body unwrap pattern,
// same hard-throw on PERSISTED_QUERY_NOT_FOUND / 401 / 403.
//
// Two persisted queries are involved:
//   1. EventPlanningListViewNavigationQuery enumerates the conference's days
//      (one aggregationId per calendar day).
//   2. PlanningListViewConnectionQuery fetches the sessions for a single day,
//      cursor-paginated via `after` / `first`.
//
// Variables + hashes pulled from a real Swapcard HAR (recon iter 19). If
// Swapcard rotates either hash this throws with "hash rotation" in the
// message — re-export a HAR and update the constants below.

const GRAPHQL_URL = "https://app.swapcard.com/api/graphql";

const NAV_OPERATION_NAME = "EventPlanningListViewNavigationQuery";
const NAV_HASH =
  "da68f6de3da6503e9497962472bea4ddf9ed3f16918826db69c4f03089dc7342";

const SESSIONS_OPERATION_NAME = "PlanningListViewConnectionQuery";
const SESSIONS_HASH =
  "5c7696e702496293ae7a4015d5fa1966960bcc7cffccbffc31a968351bf2281e";

export interface AgendaSpeaker {
  eventPeopleId: string;
  firstName: string;
  lastName: string;
  organization: string;
  photoUrl: string | null;
}

export interface ScrapedSession {
  planningId: string;
  title: string;
  beginsAt: string; // ISO 8601 with offset, as Swapcard returns it
  endsAt: string;
  place: string;
  format: string; // "PHYSICAL" | "VIRTUAL" | "HYBRID" etc. (Swapcard enum)
  categories: { id: string; name: string }[];
  description: string; // htmlDescription — untrusted, sanitise before render
  maxSeats: number | null;
  remainingSeats: number | null;
  visibility: string;
  speakers: AgendaSpeaker[];
}

export interface AgendaDay {
  aggregationId: string;
  date: string; // ISO date (YYYY-MM-DD)
}

// ── Internal response shapes ─────────────────────────────────────────────────

interface NavNode {
  aggregationId?: string;
  // Swapcard nests the date inside `value.date` (typename
  // `Core_AggregationDateValue`), not at the top level. The HAR-derived
  // recipe noted this but the initial implementation read the wrong field
  // and silently returned zero days.
  value?: { date?: string };
}

interface NavGraphQLResponse {
  data?: {
    view?: {
      navigation?: NavNode[];
    };
  };
  errors?: { message: string; extensions?: { code?: string } }[];
}

interface SpeakerNode {
  id?: string;
  firstName?: string;
  lastName?: string;
  organization?: string;
  photoUrl?: string;
}

interface CategoryNode {
  id?: string;
  name?: string;
}

interface SessionNode {
  id?: string;
  beginsAt?: string;
  endsAt?: string;
  place?: string;
  format?: string;
  htmlDescription?: string;
  maxSeats?: number | null;
  remainingSeats?: number | null;
  visibility?: string;
  categories?: CategoryNode[];
  withEvent?: {
    title?: string;
    firstSpeakers?: SpeakerNode[];
  };
}

interface SessionsGraphQLResponse {
  data?: {
    view?: {
      plannings?: {
        nodes?: SessionNode[];
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        totalCount?: number;
      };
    };
  };
  errors?: { message: string; extensions?: { code?: string } }[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildHeaders(bearerToken: string): Record<string, string> {
  return {
    accept: "*/*",
    "content-type": "application/json",
    authorization: bearerToken.startsWith("Bearer ")
      ? bearerToken
      : `Bearer ${bearerToken}`,
    "x-client-origin": "app.swapcard.com",
    "x-client-platform": "Event App",
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  };
}

function normaliseSession(node: SessionNode): ScrapedSession | null {
  if (!node.id || !node.beginsAt || !node.endsAt) return null;
  const speakers: AgendaSpeaker[] = [];
  for (const s of node.withEvent?.firstSpeakers ?? []) {
    if (!s.id || !s.firstName) continue;
    speakers.push({
      eventPeopleId: s.id,
      firstName: s.firstName.trim(),
      lastName: (s.lastName ?? "").trim(),
      organization: (s.organization ?? "").trim(),
      photoUrl: s.photoUrl?.trim() || null,
    });
  }
  const categories: { id: string; name: string }[] = [];
  for (const c of node.categories ?? []) {
    if (!c.id || !c.name) continue;
    categories.push({ id: c.id, name: c.name });
  }
  return {
    planningId: node.id,
    title: (node.withEvent?.title ?? "").trim(),
    beginsAt: node.beginsAt,
    endsAt: node.endsAt,
    place: (node.place ?? "").trim(),
    format: (node.format ?? "").trim(),
    categories,
    description: node.htmlDescription ?? "",
    maxSeats: typeof node.maxSeats === "number" ? node.maxSeats : null,
    remainingSeats:
      typeof node.remainingSeats === "number" ? node.remainingSeats : null,
    visibility: (node.visibility ?? "").trim(),
    speakers,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

// List the conference's days so the caller can fan out one paginated request
// per day. Each `aggregationId` is an opaque day token that
// PlanningListViewConnectionQuery requires as a filter.
export async function fetchAgendaDays(opts: {
  bearerToken: string;
  viewId: string;
  timezone: string;
  perRequestTimeoutMs?: number;
}): Promise<AgendaDay[]> {
  const timeout = opts.perRequestTimeoutMs ?? 15000;
  const headers = buildHeaders(opts.bearerToken);
  const body = [
    {
      operationName: NAV_OPERATION_NAME,
      variables: { viewId: opts.viewId, timezone: opts.timezone },
      extensions: {
        persistedQuery: { version: 1, sha256Hash: NAV_HASH },
      },
    },
  ];

  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    throw new Error(
      `Swapcard ${NAV_OPERATION_NAME} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`
    );
  }
  const parsed = (await res.json()) as NavGraphQLResponse[];
  const entry = parsed?.[0];
  if (!entry) {
    throw new Error(
      `Unexpected ${NAV_OPERATION_NAME} response shape: ${JSON.stringify(parsed).slice(0, 300)}`
    );
  }
  const code = entry.errors?.[0]?.extensions?.code;
  if (code === "PERSISTED_QUERY_NOT_FOUND") {
    throw new Error(
      `PERSISTED_QUERY_NOT_FOUND — Swapcard rotated the ${NAV_OPERATION_NAME} hash. Re-export a HAR and update NAV_HASH (hash rotation).`
    );
  }
  if (entry.errors?.length) {
    throw new Error(
      `Swapcard ${NAV_OPERATION_NAME} GraphQL errors: ${entry.errors.map((e) => e.message).join("; ")}`
    );
  }
  const nav = entry.data?.view?.navigation ?? [];
  const days: AgendaDay[] = [];
  for (const n of nav) {
    const date = n.value?.date;
    if (!n.aggregationId || !date) continue;
    days.push({ aggregationId: n.aggregationId, date });
  }
  return days;
}

// Cursor-paginate every day of the conference and concatenate the sessions in
// the order Swapcard returns them. 800ms gap between requests + 15s per-request
// timeout match the attendee scraper's conservative-but-not-glacial profile.
export async function fetchEventSessionsBatch(opts: {
  bearerToken: string;
  eventId: string; // base64 Swapcard event id (e.g. RXZlbnRfNDQzNjA4NQ==)
  viewId: string; // base64 agenda view id
  timezone: string; // IANA tz, e.g. "Europe/London"
  perRequestTimeoutMs?: number;
  delayMs?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<{
  sessions: ScrapedSession[];
  totalCount: number;
  pagesFetched: number;
}> {
  const timeout = opts.perRequestTimeoutMs ?? 15000;
  const delayMs = opts.delayMs ?? 800;
  const headers = buildHeaders(opts.bearerToken);

  const days = await fetchAgendaDays({
    bearerToken: opts.bearerToken,
    viewId: opts.viewId,
    timezone: opts.timezone,
    perRequestTimeoutMs: timeout,
  });

  const sessions: ScrapedSession[] = [];
  let totalCount = 0;
  let pagesFetched = 0;

  for (let d = 0; d < days.length; d += 1) {
    const day = days[d];
    let after: string | null = null;
    // Inner loop per-day: walk Relay-style pageInfo until hasNextPage is false.
    // Reset the cursor for each day so day N+1 doesn't accidentally start from
    // day N's tail.
    while (true) {
      if (delayMs > 0 && pagesFetched > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      pagesFetched += 1;
      const body = [
        {
          operationName: SESSIONS_OPERATION_NAME,
          variables: {
            eventId: opts.eventId,
            withEvent: true,
            viewId: opts.viewId,
            timezone: opts.timezone,
            aggregationsIds: [day.aggregationId],
            after,
            first: 100,
          },
          extensions: {
            persistedQuery: { version: 1, sha256Hash: SESSIONS_HASH },
          },
        },
      ];

      const res = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) {
        throw new Error(
          `Swapcard ${SESSIONS_OPERATION_NAME} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`
        );
      }
      const parsed = (await res.json()) as SessionsGraphQLResponse[];
      const entry = parsed?.[0];
      if (!entry) {
        throw new Error(
          `Unexpected ${SESSIONS_OPERATION_NAME} response shape: ${JSON.stringify(parsed).slice(0, 300)}`
        );
      }
      const code = entry.errors?.[0]?.extensions?.code;
      if (code === "PERSISTED_QUERY_NOT_FOUND") {
        throw new Error(
          `PERSISTED_QUERY_NOT_FOUND — Swapcard rotated the ${SESSIONS_OPERATION_NAME} hash. Re-export a HAR and update SESSIONS_HASH (hash rotation).`
        );
      }
      if (entry.errors?.length) {
        throw new Error(
          `Swapcard ${SESSIONS_OPERATION_NAME} GraphQL errors: ${entry.errors.map((e) => e.message).join("; ")}`
        );
      }
      const plannings = entry.data?.view?.plannings;
      if (!plannings) {
        throw new Error(
          `Unexpected ${SESSIONS_OPERATION_NAME} response shape: ${JSON.stringify(entry).slice(0, 300)}`
        );
      }
      for (const node of plannings.nodes ?? []) {
        const session = normaliseSession(node);
        if (session) sessions.push(session);
      }
      // Swapcard returns totalCount per-page; the value can shift between
      // days but the highest value we see is a fair upper bound for the
      // progress callback.
      if (typeof plannings.totalCount === "number") {
        totalCount = Math.max(totalCount, plannings.totalCount);
      }
      opts.onProgress?.(sessions.length, totalCount);

      if (!plannings.pageInfo?.hasNextPage) break;
      after = plannings.pageInfo.endCursor ?? null;
      if (!after) break;
    }
  }

  return { sessions, totalCount, pagesFetched };
}
