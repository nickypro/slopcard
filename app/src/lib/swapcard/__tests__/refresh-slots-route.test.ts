import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// iter 19 pen-test: POST /api/swapcard/refresh-slots must intersect any
// supplied `peopleIds` with the cached attendee set so an admin-token leak
// can't be amplified into arbitrary Swapcard GraphQL fan-out.

const authMock = vi.hoisted(() => ({
  isAdmin: vi.fn(),
}));
vi.mock("@/lib/auth", () => authMock);

const dbMock = vi.hoisted(() => ({
  listAttendeesWithEventPeopleId: vi.fn(),
  setAttendeeSlots: vi.fn(),
}));
vi.mock("@/lib/db", () => dbMock);

const scrapeMock = vi.hoisted(() => ({
  fetchMeetSlotsBatch: vi.fn(),
}));
vi.mock("@/lib/swapcard/scrape-agenda", () => scrapeMock);

describe("POST /api/swapcard/refresh-slots", () => {
  beforeEach(() => {
    authMock.isAdmin.mockReset();
    dbMock.listAttendeesWithEventPeopleId.mockReset();
    dbMock.setAttendeeSlots.mockReset();
    scrapeMock.fetchMeetSlotsBatch.mockReset();
    authMock.isAdmin.mockResolvedValue(true);
    vi.stubEnv("SWAPCARD_EVENT_ID", "eag-london-2026");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function callRoute(body: unknown) {
    const { POST } = await import("@/app/api/swapcard/refresh-slots/route");
    const req = new Request("http://localhost/api/swapcard/refresh-slots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return POST(req as never);
  }

  it("drops unknown peopleIds, keeps the known ones", async () => {
    dbMock.listAttendeesWithEventPeopleId.mockReturnValue([
      "EventPeople_KNOWN_1",
      "EventPeople_KNOWN_2",
    ]);
    scrapeMock.fetchMeetSlotsBatch.mockResolvedValue([
      { peopleId: "EventPeople_KNOWN_1", slots: [] },
    ]);

    const res = await callRoute({
      token: "JWT",
      peopleIds: ["EventPeople_KNOWN_1", "EventPeople_ATTACKER"],
    });
    expect(res.status).toBe(200);
    // Only the known id was passed to the upstream scraper.
    const callArgs = scrapeMock.fetchMeetSlotsBatch.mock.calls[0]![0];
    expect(callArgs.peopleIds).toEqual(["EventPeople_KNOWN_1"]);
  });

  it("returns 400 when ALL supplied peopleIds are unknown", async () => {
    dbMock.listAttendeesWithEventPeopleId.mockReturnValue([
      "EventPeople_KNOWN_1",
    ]);
    const res = await callRoute({
      token: "JWT",
      peopleIds: ["EventPeople_ATTACKER", "EventPeople_OTHER_ATTACKER"],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("no known event_people_ids");
    expect(scrapeMock.fetchMeetSlotsBatch).not.toHaveBeenCalled();
  });

  it("defaults to the full allowed set when peopleIds is omitted", async () => {
    dbMock.listAttendeesWithEventPeopleId.mockReturnValue([
      "EventPeople_KNOWN_1",
      "EventPeople_KNOWN_2",
    ]);
    scrapeMock.fetchMeetSlotsBatch.mockResolvedValue([]);

    const res = await callRoute({ token: "JWT" });
    expect(res.status).toBe(200);
    const callArgs = scrapeMock.fetchMeetSlotsBatch.mock.calls[0]![0];
    // Order is set-iteration order; assert content via a Set.
    expect(new Set(callArgs.peopleIds)).toEqual(
      new Set(["EventPeople_KNOWN_1", "EventPeople_KNOWN_2"])
    );
  });

  it("returns 200 with refreshed=0 when nobody has an event_people_id", async () => {
    dbMock.listAttendeesWithEventPeopleId.mockReturnValue([]);
    const res = await callRoute({ token: "JWT" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { refreshed?: number };
    expect(body.refreshed).toBe(0);
    expect(scrapeMock.fetchMeetSlotsBatch).not.toHaveBeenCalled();
  });

  it("rejects non-admin callers with 403", async () => {
    authMock.isAdmin.mockResolvedValue(false);
    const res = await callRoute({ token: "JWT" });
    expect(res.status).toBe(403);
  });
});
