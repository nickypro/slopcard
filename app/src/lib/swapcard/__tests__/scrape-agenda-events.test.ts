import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchAgendaDays,
  fetchEventSessionsBatch,
} from "@/lib/swapcard/scrape-agenda-events";

const EVENT_ID = "RXZlbnRfNDQzNjA4NQ==";
const VIEW_ID = "RXZlbnRWaWV3XzEyNzQyMDA=";
const TZ = "Europe/London";

// ── Fixture builders ────────────────────────────────────────────────────────

function navResponse(
  days: { aggregationId: string; date: string }[]
): Response {
  // Swapcard nests the date inside `value.date` on the wire — fixtures must
  // mirror that or the parser correctly skips them.
  return new Response(
    JSON.stringify([
      {
        data: {
          view: {
            navigation: days.map((d) => ({
              aggregationId: d.aggregationId,
              value: { date: d.date },
            })),
          },
        },
      },
    ]),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

interface SessionInput {
  id: string;
  beginsAt: string;
  endsAt: string;
  title?: string;
  place?: string;
  format?: string;
  speakers?: {
    id: string;
    firstName: string;
    lastName?: string;
    organization?: string;
    photoUrl?: string;
  }[];
  categories?: { id: string; name: string }[];
  htmlDescription?: string;
}

function sessionsResponse(
  sessions: SessionInput[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
  totalCount?: number
): Response {
  const nodes = sessions.map((s) => ({
    id: s.id,
    beginsAt: s.beginsAt,
    endsAt: s.endsAt,
    place: s.place ?? "",
    format: s.format ?? "PHYSICAL",
    htmlDescription: s.htmlDescription ?? "",
    maxSeats: null,
    remainingSeats: null,
    visibility: "PUBLIC",
    categories: s.categories ?? [],
    withEvent: {
      title: s.title ?? "",
      firstSpeakers: s.speakers ?? [],
    },
  }));
  return new Response(
    JSON.stringify([
      {
        data: {
          view: {
            plannings: {
              nodes,
              pageInfo,
              totalCount: totalCount ?? nodes.length,
            },
          },
        },
      },
    ]),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function errResponse(code: string): Response {
  return new Response(
    JSON.stringify([
      { errors: [{ message: "x", extensions: { code } }] },
    ]),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("fetchAgendaDays", () => {
  afterEach(() => vi.restoreAllMocks());

  it("happy path returns days in Swapcard's order", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      navResponse([
        { aggregationId: "AGG_1", date: "2026-05-29" },
        { aggregationId: "AGG_2", date: "2026-05-30" },
        { aggregationId: "AGG_3", date: "2026-05-31" },
      ])
    );

    const out = await fetchAgendaDays({
      bearerToken: "Bearer abc",
      viewId: VIEW_ID,
      timezone: TZ,
    });

    expect(out).toEqual([
      { aggregationId: "AGG_1", date: "2026-05-29" },
      { aggregationId: "AGG_2", date: "2026-05-30" },
      { aggregationId: "AGG_3", date: "2026-05-31" },
    ]);
  });

  it("throws on PERSISTED_QUERY_NOT_FOUND mentioning hash rotation", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errResponse("PERSISTED_QUERY_NOT_FOUND")
    );

    await expect(
      fetchAgendaDays({
        bearerToken: "Bearer abc",
        viewId: VIEW_ID,
        timezone: TZ,
      })
    ).rejects.toThrow(/PERSISTED_QUERY_NOT_FOUND/);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errResponse("PERSISTED_QUERY_NOT_FOUND")
    );
    await expect(
      fetchAgendaDays({
        bearerToken: "Bearer abc",
        viewId: VIEW_ID,
        timezone: TZ,
      })
    ).rejects.toThrow(/rotat/i);
  });

  it("auto-prefixes Bearer when token doesn't already have it", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(navResponse([]));
    await fetchAgendaDays({
      bearerToken: "raw-jwt",
      viewId: VIEW_ID,
      timezone: TZ,
    });
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers.authorization).toBe("Bearer raw-jwt");
  });

  it("does not double-prefix Bearer when already present", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(navResponse([]));
    await fetchAgendaDays({
      bearerToken: "Bearer ready",
      viewId: VIEW_ID,
      timezone: TZ,
    });
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers.authorization).toBe("Bearer ready");
  });

  it("throws on HTTP 401 hard-fail", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("unauthorized", { status: 401 })
    );
    await expect(
      fetchAgendaDays({
        bearerToken: "Bearer expired",
        viewId: VIEW_ID,
        timezone: TZ,
      })
    ).rejects.toThrow(/401/);
  });
});

describe("fetchEventSessionsBatch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("happy path: one day, single page returns normalised sessions", async () => {
    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return navResponse([{ aggregationId: "AGG_1", date: "2026-05-29" }]);
      }
      return sessionsResponse(
        [
          {
            id: "Planning_1",
            beginsAt: "2026-05-29T09:00:00+01:00",
            endsAt: "2026-05-29T10:00:00+01:00",
            title: "Opening Keynote",
            place: "Main Hall",
            categories: [{ id: "C_1", name: "Plenary" }],
            speakers: [
              {
                id: "EventPeople_1",
                firstName: "Alice",
                lastName: "Smith",
                organization: "Anthropic",
                photoUrl: "https://cdn.swapcard.com/x.jpg",
              },
            ],
          },
        ],
        { hasNextPage: false, endCursor: null }
      );
    });

    const out = await fetchEventSessionsBatch({
      bearerToken: "Bearer abc",
      eventId: EVENT_ID,
      viewId: VIEW_ID,
      timezone: TZ,
      delayMs: 0,
    });

    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0]).toMatchObject({
      planningId: "Planning_1",
      title: "Opening Keynote",
      place: "Main Hall",
      categories: [{ id: "C_1", name: "Plenary" }],
    });
    expect(out.sessions[0].speakers[0]).toEqual({
      eventPeopleId: "EventPeople_1",
      firstName: "Alice",
      lastName: "Smith",
      organization: "Anthropic",
      photoUrl: "https://cdn.swapcard.com/x.jpg",
    });
    // 1 nav call + 1 sessions call = 2 fetches total.
    expect(call).toBe(2);
    expect(out.pagesFetched).toBe(1);
  });

  it("pagination: two pages on one day are concatenated in order", async () => {
    let sessionsCall = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      const op = body[0].operationName;
      if (op === "EventPlanningListViewNavigationQuery") {
        return navResponse([{ aggregationId: "AGG_1", date: "2026-05-29" }]);
      }
      sessionsCall += 1;
      if (sessionsCall === 1) {
        // First request: no `after` cursor, expects hasNextPage:true.
        expect(body[0].variables.after).toBeNull();
        return sessionsResponse(
          [
            {
              id: "Planning_A",
              beginsAt: "2026-05-29T09:00:00+01:00",
              endsAt: "2026-05-29T09:30:00+01:00",
            },
            {
              id: "Planning_B",
              beginsAt: "2026-05-29T09:30:00+01:00",
              endsAt: "2026-05-29T10:00:00+01:00",
            },
          ],
          { hasNextPage: true, endCursor: "CURSOR_X" },
          4
        );
      }
      // Second request: should pass the cursor from page 1.
      expect(body[0].variables.after).toBe("CURSOR_X");
      return sessionsResponse(
        [
          {
            id: "Planning_C",
            beginsAt: "2026-05-29T10:00:00+01:00",
            endsAt: "2026-05-29T10:30:00+01:00",
          },
          {
            id: "Planning_D",
            beginsAt: "2026-05-29T10:30:00+01:00",
            endsAt: "2026-05-29T11:00:00+01:00",
          },
        ],
        { hasNextPage: false, endCursor: null },
        4
      );
    });

    const out = await fetchEventSessionsBatch({
      bearerToken: "Bearer abc",
      eventId: EVENT_ID,
      viewId: VIEW_ID,
      timezone: TZ,
      delayMs: 0,
    });

    expect(out.sessions.map((s) => s.planningId)).toEqual([
      "Planning_A",
      "Planning_B",
      "Planning_C",
      "Planning_D",
    ]);
    expect(out.pagesFetched).toBe(2);
    expect(out.totalCount).toBe(4);
  });

  it("throws when the NAV call returns PERSISTED_QUERY_NOT_FOUND, mentioning hash rotation", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errResponse("PERSISTED_QUERY_NOT_FOUND")
    );

    await expect(
      fetchEventSessionsBatch({
        bearerToken: "Bearer abc",
        eventId: EVENT_ID,
        viewId: VIEW_ID,
        timezone: TZ,
      })
    ).rejects.toThrow(/PERSISTED_QUERY_NOT_FOUND.*rotat/i);
  });

  it("throws when the SESSIONS call returns PERSISTED_QUERY_NOT_FOUND, mentioning hash rotation", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      const op = body[0].operationName;
      if (op === "EventPlanningListViewNavigationQuery") {
        return navResponse([{ aggregationId: "AGG_1", date: "2026-05-29" }]);
      }
      return errResponse("PERSISTED_QUERY_NOT_FOUND");
    });

    await expect(
      fetchEventSessionsBatch({
        bearerToken: "Bearer abc",
        eventId: EVENT_ID,
        viewId: VIEW_ID,
        timezone: TZ,
      })
    ).rejects.toThrow(/PERSISTED_QUERY_NOT_FOUND.*rotat/i);
  });

  it("auto-prefixes Bearer through both nav + sessions calls", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) => {
        const body = JSON.parse((init as RequestInit).body as string);
        const op = body[0].operationName;
        if (op === "EventPlanningListViewNavigationQuery") {
          return navResponse([{ aggregationId: "AGG_1", date: "2026-05-29" }]);
        }
        return sessionsResponse([], { hasNextPage: false, endCursor: null });
      });

    await fetchEventSessionsBatch({
      bearerToken: "raw-jwt",
      eventId: EVENT_ID,
      viewId: VIEW_ID,
      timezone: TZ,
      delayMs: 0,
    });

    for (const call of fetchSpy.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer raw-jwt");
    }
  });

  it("HTTP 401 on the sessions call hard-throws", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      const op = body[0].operationName;
      if (op === "EventPlanningListViewNavigationQuery") {
        return navResponse([{ aggregationId: "AGG_1", date: "2026-05-29" }]);
      }
      return new Response("unauthorized", { status: 401 });
    });

    await expect(
      fetchEventSessionsBatch({
        bearerToken: "Bearer expired",
        eventId: EVENT_ID,
        viewId: VIEW_ID,
        timezone: TZ,
        delayMs: 0,
      })
    ).rejects.toThrow(/401/);
  });

  it("onProgress ticks at least once per sessions-fetch", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      const op = body[0].operationName;
      if (op === "EventPlanningListViewNavigationQuery") {
        return navResponse([
          { aggregationId: "AGG_1", date: "2026-05-29" },
          { aggregationId: "AGG_2", date: "2026-05-30" },
        ]);
      }
      // Each day single-page.
      const agg = body[0].variables.aggregationsIds[0];
      return sessionsResponse(
        [
          {
            id: `Planning_${agg}_1`,
            beginsAt: "2026-05-29T09:00:00+01:00",
            endsAt: "2026-05-29T10:00:00+01:00",
          },
        ],
        { hasNextPage: false, endCursor: null }
      );
    });

    const progress: Array<[number, number]> = [];
    await fetchEventSessionsBatch({
      bearerToken: "Bearer abc",
      eventId: EVENT_ID,
      viewId: VIEW_ID,
      timezone: TZ,
      delayMs: 0,
      onProgress: (done, total) => progress.push([done, total]),
    });

    // Two sessions-fetches → two progress ticks, with `done` monotonically
    // increasing.
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress[progress.length - 1][0]).toBe(2);
  });
});
