import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchMeetSlotsBatch } from "@/lib/swapcard/scrape-agenda";

const EVENT_ID = "RXZlbnRfNDQzNjA4NQ==";
const DATE_RANGE = {
  start: "2026-05-29T08:00:00+01:00",
  end: "2026-06-01T20:00:00+01:00",
};

const okResponse = (
  nodes: { id: string; starts: string; ends: string }[]
): Response =>
  new Response(
    JSON.stringify([
      { data: { event: { availableMeetingSlots: { nodes } } } },
    ]),
    { status: 200, headers: { "content-type": "application/json" } }
  );

const errResponse = (code: string): Response =>
  new Response(
    JSON.stringify([
      { errors: [{ message: "x", extensions: { code } }] },
    ]),
    { status: 200, headers: { "content-type": "application/json" } }
  );

describe("fetchMeetSlotsBatch", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("single personId happy path returns parsed slots in order", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okResponse([
        { id: "Slot_1", starts: "2026-05-29T09:00:00+01:00", ends: "2026-05-29T09:15:00+01:00" },
        { id: "Slot_2", starts: "2026-05-29T09:15:00+01:00", ends: "2026-05-29T09:30:00+01:00" },
      ])
    );

    const out = await fetchMeetSlotsBatch({
      bearerToken: "Bearer abc",
      eventId: EVENT_ID,
      peopleIds: ["CommunityProfile_42"],
      dateRange: DATE_RANGE,
    });

    expect(out).toEqual([
      {
        peopleId: "CommunityProfile_42",
        slots: [
          { id: "Slot_1", starts: "2026-05-29T09:00:00+01:00", ends: "2026-05-29T09:15:00+01:00" },
          { id: "Slot_2", starts: "2026-05-29T09:15:00+01:00", ends: "2026-05-29T09:30:00+01:00" },
        ],
      },
    ]);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("unwraps the batched array response shape (r.json()[0])", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okResponse([
        { id: "S1", starts: "2026-05-29T10:00:00+01:00", ends: "2026-05-29T10:15:00+01:00" },
      ])
    );

    const out = await fetchMeetSlotsBatch({
      bearerToken: "Bearer abc",
      eventId: EVENT_ID,
      peopleIds: ["EventPeople_7"],
      dateRange: DATE_RANGE,
    });

    expect(out[0].slots).toHaveLength(1);
    expect(out[0].slots[0].id).toBe("S1");
    // sanity: request body sent as a JSON array
    const sentBody = (fetchSpy.mock.calls[0][1] as RequestInit).body as string;
    expect(JSON.parse(sentBody)).toBeInstanceOf(Array);
  });

  it("auto-prefixes Bearer when the token doesn't already have it", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(okResponse([]));

    await fetchMeetSlotsBatch({
      bearerToken: "raw-jwt-no-prefix",
      eventId: EVENT_ID,
      peopleIds: ["CommunityProfile_1"],
      dateRange: DATE_RANGE,
    });

    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers.authorization).toBe("Bearer raw-jwt-no-prefix");
  });

  it("does not double-prefix Bearer when already present", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(okResponse([]));

    await fetchMeetSlotsBatch({
      bearerToken: "Bearer already-set",
      eventId: EVENT_ID,
      peopleIds: ["CommunityProfile_1"],
      dateRange: DATE_RANGE,
    });

    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers.authorization).toBe("Bearer already-set");
  });

  it("accepts mixed CommunityProfile_ and EventPeople_ IDs in one call", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) => {
        const body = JSON.parse((init as RequestInit).body as string);
        const pid = body[0].variables.peopleIds[0];
        return okResponse([
          {
            id: `Slot_for_${pid}`,
            starts: "2026-05-29T11:00:00+01:00",
            ends: "2026-05-29T11:15:00+01:00",
          },
        ]);
      });

    const out = await fetchMeetSlotsBatch({
      bearerToken: "Bearer abc",
      eventId: EVENT_ID,
      peopleIds: ["CommunityProfile_42", "EventPeople_99"],
      dateRange: DATE_RANGE,
    });

    expect(out).toHaveLength(2);
    expect(out[0].peopleId).toBe("CommunityProfile_42");
    expect(out[0].slots[0].id).toBe("Slot_for_CommunityProfile_42");
    expect(out[1].peopleId).toBe("EventPeople_99");
    expect(out[1].slots[0].id).toBe("Slot_for_EventPeople_99");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns { peopleId, slots: [] } when availableMeetingSlots.nodes is empty", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse([]));

    const out = await fetchMeetSlotsBatch({
      bearerToken: "Bearer abc",
      eventId: EVENT_ID,
      peopleIds: ["CommunityProfile_1"],
      dateRange: DATE_RANGE,
    });

    expect(out).toEqual([{ peopleId: "CommunityProfile_1", slots: [] }]);
  });

  it("throws when GraphQL returns PERSISTED_QUERY_NOT_FOUND, mentioning hash rotation", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errResponse("PERSISTED_QUERY_NOT_FOUND")
    );

    await expect(
      fetchMeetSlotsBatch({
        bearerToken: "Bearer abc",
        eventId: EVENT_ID,
        peopleIds: ["CommunityProfile_1"],
        dateRange: DATE_RANGE,
      })
    ).rejects.toThrow(/PERSISTED_QUERY_NOT_FOUND/);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errResponse("PERSISTED_QUERY_NOT_FOUND")
    );

    await expect(
      fetchMeetSlotsBatch({
        bearerToken: "Bearer abc",
        eventId: EVENT_ID,
        peopleIds: ["CommunityProfile_1"],
        dateRange: DATE_RANGE,
      })
    ).rejects.toThrow(/rotat/i);
  });

  it("per-person timeout: failing call returns empty slots while others succeed", async () => {
    const goodNodes = (pid: string) => [
      {
        id: `Slot_${pid}`,
        starts: "2026-05-29T12:00:00+01:00",
        ends: "2026-05-29T12:15:00+01:00",
      },
    ];
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      const pid = body[0].variables.peopleIds[0];
      if (pid === "CommunityProfile_3") {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      }
      return okResponse(goodNodes(pid));
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      fetchMock as unknown as typeof fetch
    );

    const out = await fetchMeetSlotsBatch({
      bearerToken: "Bearer abc",
      eventId: EVENT_ID,
      peopleIds: [
        "CommunityProfile_1",
        "CommunityProfile_2",
        "CommunityProfile_3",
      ],
      dateRange: DATE_RANGE,
    });

    expect(out[0].slots).toHaveLength(1);
    expect(out[1].slots).toHaveLength(1);
    expect(out[2]).toEqual({ peopleId: "CommunityProfile_3", slots: [] });
    expect(warnSpy).toHaveBeenCalled();
  });

  it("concurrency cap: with concurrency=2 and 5 IDs, never more than 2 in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // yield twice so the worker pool has time to attempt to over-schedule
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return okResponse([]);
    });

    await fetchMeetSlotsBatch({
      bearerToken: "Bearer abc",
      eventId: EVENT_ID,
      peopleIds: ["a", "b", "c", "d", "e"],
      dateRange: DATE_RANGE,
      concurrency: 2,
    });

    expect(maxInFlight).toBe(2);
  });

  it("invokes onProgress after each completed request with (done, total)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse([]));
    const progress: Array<[number, number]> = [];

    await fetchMeetSlotsBatch({
      bearerToken: "Bearer abc",
      eventId: EVENT_ID,
      peopleIds: ["a", "b", "c"],
      dateRange: DATE_RANGE,
      concurrency: 1,
      onProgress: (done, total) => progress.push([done, total]),
    });

    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("HTTP 401 throws, does not swallow into per-person fallback", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("unauthorized", { status: 401 })
    );

    await expect(
      fetchMeetSlotsBatch({
        bearerToken: "Bearer expired",
        eventId: EVENT_ID,
        peopleIds: ["CommunityProfile_1", "CommunityProfile_2"],
        dateRange: DATE_RANGE,
      })
    ).rejects.toThrow(/401/);
  });
});
