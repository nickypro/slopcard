import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Closeness-rank endpoint test. Mirrors the saved-summary mock pattern so we
// don't need a real DB — we mock @/lib/db + @/lib/session and feed the route
// canned attendee rows whose embeddings live entirely in the BLOB column.

const sessionMock = vi.hoisted(() => ({
  getUserSession: vi.fn(),
}));
vi.mock("@/lib/session", () => sessionMock);

const dbMock = vi.hoisted(() => ({
  getCard: vi.fn(),
  getSwapcardAttendeeByAnyId: vi.fn(),
}));
vi.mock("@/lib/db", () => dbMock);

import { __resetRateLimitState } from "@/lib/swapcard/rate-limit";
import { EMBED_DIM, vectorToBlob } from "@/lib/swapcard/embed";

// Build a normalised vector that points entirely along one axis. Cosine
// between two such vectors collapses to dot-product on the shared axis, so
// equal-axis vectors give 1 and orthogonal vectors give 0 — easy to assert.
function unitAxisVec(axis: number): Buffer {
  const v = new Float32Array(EMBED_DIM);
  v[axis] = 1;
  return vectorToBlob(v);
}

describe("POST /api/swapcard/closeness-rank", () => {
  beforeEach(() => {
    sessionMock.getUserSession.mockReset();
    dbMock.getCard.mockReset();
    dbMock.getSwapcardAttendeeByAnyId.mockReset();
    __resetRateLimitState();
    sessionMock.getUserSession.mockResolvedValue({
      twitterId: "1",
      twitterHandle: "alice",
      exp: Date.now() / 1000 + 3600,
    });
    dbMock.getCard.mockReturnValue({
      handle: "alice",
      swapcardPersonId: "ME",
      swapcardEventId: "eag-london-2026",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function callRoute(body: unknown) {
    const { POST } = await import("@/app/api/swapcard/closeness-rank/route");
    const req = new Request("http://localhost/api/swapcard/closeness-rank", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return POST(req as never);
  }

  it("returns 401 when not signed in", async () => {
    sessionMock.getUserSession.mockResolvedValueOnce(null);
    const res = await callRoute({ ids: [] });
    expect(res.status).toBe(401);
  });

  it("returns 412 when the user hasn't linked a Swapcard profile", async () => {
    dbMock.getCard.mockReturnValueOnce({
      handle: "alice",
      swapcardPersonId: null,
      swapcardEventId: null,
    });
    const res = await callRoute({ ids: ["X"] });
    expect(res.status).toBe(412);
  });

  it("returns 410 when the requester isn't in the attendee cache", async () => {
    dbMock.getSwapcardAttendeeByAnyId.mockReturnValueOnce(null);
    const res = await callRoute({ ids: ["X"] });
    expect(res.status).toBe(410);
  });

  it("returns 400 when more than 50 ids are posted", async () => {
    // ME row needs to exist for the route to get past the gate before the
    // cap check, but with 51 ids we expect to hit the cap first.
    dbMock.getSwapcardAttendeeByAnyId.mockImplementation((_event: string, id: string) => {
      if (id === "ME") return { embedding: unitAxisVec(0) };
      return null;
    });
    const ids = Array.from({ length: 51 }, (_, i) => `EventPeople_${i}`);
    const res = await callRoute({ ids });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("max 50");
  });

  it("computes cosine similarity for each id and returns plain-object map", async () => {
    // requester vector points along axis 0.
    const meEmb = unitAxisVec(0);
    const aEmb = unitAxisVec(0); // identical → cosine 1
    const bEmb = unitAxisVec(1); // orthogonal → cosine 0
    dbMock.getSwapcardAttendeeByAnyId.mockImplementation((_e: string, id: string) => {
      if (id === "ME") return { embedding: meEmb };
      if (id === "A") return { embedding: aEmb };
      if (id === "B") return { embedding: bEmb };
      return null;
    });
    const res = await callRoute({ ids: ["A", "B", "MISSING"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      similarities: Record<string, number>;
    };
    expect(body.ok).toBe(true);
    expect(Object.keys(body.similarities).sort()).toEqual(["A", "B"]);
    expect(body.similarities.A).toBeCloseTo(1, 5);
    expect(body.similarities.B).toBeCloseTo(0, 5);
    // Missing id is simply absent from the response (client treats as last).
    expect(body.similarities.MISSING).toBeUndefined();
  });

  it("ignores non-string ids in the input array", async () => {
    dbMock.getSwapcardAttendeeByAnyId.mockImplementation((_e: string, id: string) => {
      if (id === "ME") return { embedding: unitAxisVec(0) };
      if (id === "A") return { embedding: unitAxisVec(0) };
      return null;
    });
    const res = await callRoute({ ids: ["A", null, 42, ""] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      similarities: Record<string, number>;
    };
    expect(Object.keys(body.similarities)).toEqual(["A"]);
  });
});
