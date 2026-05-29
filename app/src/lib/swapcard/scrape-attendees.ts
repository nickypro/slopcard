// Authenticated scrape of Swapcard's attendee list to recover EventPeople IDs
// for each person. The sheet (which we ingest as our primary source) stores
// CommunityProfile_<n> IDs, but Swapcard's browser app shows EventPeople_<n>
// in the URL — so without this scrape, a user pasting their own profile URL
// can't be matched against the sheet record.
//
// Pulled by an admin endpoint using a bearer JWT the user supplies (same
// token as the kryjak tool's `SWAPCARD_TOKEN` — fetched from DevTools and
// expiring in ~24h). The token is NOT stored anywhere on disk; it lives only
// in the request lifecycle.
//
// Query + persisted-query hash extracted from a real Swapcard session HAR.
// If Swapcard rotates the persisted query, this returns PERSISTED_QUERY_NOT_FOUND
// and the admin endpoint surfaces the error.

const GRAPHQL_URL = "https://app.swapcard.com/api/graphql";
const OPERATION_NAME = "EventPeopleListViewConnectionQuery";
const PERSISTED_HASH =
  "c5db6335ec685ffb07963360466f639262d04d8c5cbaa89e5f5992ee20bb6579";

// Default view for EAG London 2026 attendees. The viewId is event-specific;
// for other events you'd grab it from a fresh HAR (look at the variables
// passed to EventPeopleListViewConnectionQuery).
const DEFAULT_VIEW_ID = "RXZlbnRWaWV3XzEyNzQyMDI=";

export interface ScrapedAttendee {
  eventPeopleId: string;
  userId: string | null;
  firstName: string;
  lastName: string;
  photoUrl: string | null;
  // Captured from EventPeople so stubs can render `Ben Stewart · Sr Eng ·
  // Anthropic` instead of just `Ben Stewart` four times (the cohort has many
  // genuine name collisions; without role/org they look like dupes).
  jobTitle: string;
  organization: string;
}

interface GraphQLNode {
  id?: string;
  firstName?: string;
  lastName?: string;
  jobTitle?: string;
  organization?: string;
  photoUrl?: string;
  userInfo?: { id?: string };
}

interface GraphQLResponse {
  data?: {
    view?: {
      people?: {
        nodes?: GraphQLNode[];
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        totalCount?: number;
      };
    };
  };
  errors?: { message: string; extensions?: { code?: string } }[];
}

export interface ScrapeResult {
  attendees: ScrapedAttendee[];
  totalCount: number;
  pagesFetched: number;
}

export async function scrapeEventPeople(opts: {
  bearerToken: string;
  viewId?: string;
  delayMs?: number;
  maxPages?: number;
  onProgress?: (fetched: number, total: number) => void;
}): Promise<ScrapeResult> {
  const viewId = opts.viewId ?? DEFAULT_VIEW_ID;
  const delayMs = opts.delayMs ?? 800;
  const maxPages = opts.maxPages ?? 200;
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

  const attendees: ScrapedAttendee[] = [];
  let endCursor: string | null = null;
  let totalCount = 0;
  let pages = 0;

  while (pages < maxPages) {
    pages += 1;
    const variables: { viewId: string; endCursor?: string } = { viewId };
    if (endCursor) variables.endCursor = endCursor;

    // 15s per-page ceiling so a single stalled Swapcard response can't wedge
    // the admin worker indefinitely. The loop has its own maxPages cap, but
    // without a request-level timeout one bad page hangs forever.
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        operationName: OPERATION_NAME,
        variables,
        extensions: { persistedQuery: { version: 1, sha256Hash: PERSISTED_HASH } },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(
        `Swapcard GraphQL HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`
      );
    }
    const body = (await res.json()) as GraphQLResponse;
    const code = body.errors?.[0]?.extensions?.code;
    if (code === "PERSISTED_QUERY_NOT_FOUND") {
      throw new Error(
        "PERSISTED_QUERY_NOT_FOUND — Swapcard rotated the query hash. Re-export a HAR and update PERSISTED_HASH."
      );
    }
    if (body.errors?.length) {
      throw new Error(`Swapcard GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    const people = body.data?.view?.people;
    if (!people) {
      throw new Error(`Unexpected response shape: ${JSON.stringify(body).slice(0, 300)}`);
    }

    for (const node of people.nodes ?? []) {
      if (!node.id || !node.firstName) continue;
      attendees.push({
        eventPeopleId: node.id,
        userId: node.userInfo?.id ?? null,
        firstName: node.firstName.trim(),
        lastName: (node.lastName ?? "").trim(),
        photoUrl: node.photoUrl?.trim() || null,
        jobTitle: node.jobTitle?.trim() ?? "",
        organization: node.organization?.trim() ?? "",
      });
    }
    totalCount = people.totalCount ?? totalCount;
    opts.onProgress?.(attendees.length, totalCount);

    if (!people.pageInfo?.hasNextPage) break;
    endCursor = people.pageInfo.endCursor ?? null;
    if (!endCursor) break;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  return { attendees, totalCount, pagesFetched: pages };
}

// Normalize a name for matching across data sources: lowercase, strip
// diacritics, collapse whitespace, drop common punctuation. Lets "José
// García-López" match "jose garcia lopez" between the sheet and Swapcard.
export function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
