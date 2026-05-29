import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// iter 19 pen-test: the saved-summary endpoint caps personIds at MAX_IDS (50)
// to bound both the IN-clause cost and the slot-overlap oracle surface. Over
// the cap should hard-400 instead of silently slicing — clients that have
// drifted off the contract deserve to know.

const sessionMock = vi.hoisted(() => ({
  getUserSession: vi.fn(),
}));
vi.mock("@/lib/session", () => sessionMock);

const dbMock = vi.hoisted(() => ({
  getCard: vi.fn(),
  getSwapcardAttendeeByAnyId: vi.fn(),
  getAttendeeSlots: vi.fn(),
  listSavedAttendees: vi.fn(),
}));
vi.mock("@/lib/db", () => dbMock);

import { __resetRateLimitState } from "@/lib/swapcard/rate-limit";

describe("POST /api/swapcard/saved-summary", () => {
  beforeEach(() => {
    sessionMock.getUserSession.mockReset();
    dbMock.getCard.mockReset();
    dbMock.getSwapcardAttendeeByAnyId.mockReset();
    dbMock.getAttendeeSlots.mockReset();
    dbMock.listSavedAttendees.mockReset();
    __resetRateLimitState();
    sessionMock.getUserSession.mockResolvedValue({
      twitterId: "1",
      twitterHandle: "alice",
      exp: Date.now() / 1000 + 3600,
    });
    dbMock.getCard.mockReturnValue({
      handle: "alice",
      swapcardPersonId: "PERSON_ME",
      swapcardEventId: "eag-london-2026",
    });
    dbMock.getSwapcardAttendeeByAnyId.mockReturnValue(null);
    dbMock.getAttendeeSlots.mockReturnValue(null);
    dbMock.listSavedAttendees.mockReturnValue([]);
    vi.stubEnv("SWAPCARD_EVENT_ID", "eag-london-2026");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function callRoute(body: unknown) {
    const { POST } = await import("@/app/api/swapcard/saved-summary/route");
    const req = new Request("http://localhost/api/swapcard/saved-summary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return POST(req as never);
  }

  it("returns 400 when more than 50 personIds are posted", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `EventPeople_${i}`);
    const res = await callRoute({ personIds: ids });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("max 50");
    expect(dbMock.listSavedAttendees).not.toHaveBeenCalled();
  });

  it("accepts exactly 50 personIds (boundary)", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `EventPeople_${i}`);
    const res = await callRoute({ personIds: ids });
    expect(res.status).toBe(200);
    expect(dbMock.listSavedAttendees).toHaveBeenCalledTimes(1);
  });
});
