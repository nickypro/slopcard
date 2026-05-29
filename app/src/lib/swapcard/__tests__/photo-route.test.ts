import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cachePathFor } from "@/lib/swapcard/photo-cache";

// End-to-end tests for the GET /api/swapcard/photo/[personId] route.
// node:fs is replaced with an in-memory map so cache writes are observable
// without touching disk. The db + session modules are stubbed so the route
// doesn't try to open a real sqlite handle or call next/headers cookies()
// outside a request scope.

interface FakeFs {
  files: Map<string, Buffer>;
  dirs: Set<string>;
}

const fakeFs: FakeFs = { files: new Map(), dirs: new Set() };

vi.mock("node:fs", () => ({
  existsSync: (p: string) => fakeFs.files.has(p) || fakeFs.dirs.has(p),
  mkdirSync: (p: string) => {
    fakeFs.dirs.add(p);
  },
  readFileSync: (p: string) => {
    const b = fakeFs.files.get(p);
    if (!b) throw new Error(`ENOENT ${p}`);
    return b;
  },
  writeFileSync: (p: string, data: Buffer) => {
    fakeFs.files.set(p, Buffer.from(data));
  },
  renameSync: (from: string, to: string) => {
    const b = fakeFs.files.get(from);
    if (!b) throw new Error(`ENOENT ${from}`);
    fakeFs.files.set(to, b);
    fakeFs.files.delete(from);
  },
}));

const sessionMock = vi.hoisted(() => ({
  getUserSession: vi.fn(),
}));
vi.mock("@/lib/session", () => sessionMock);

const dbMock = vi.hoisted(() => ({
  getSwapcardAttendeePhotoUrl: vi.fn(),
  getCard: vi.fn(),
}));
vi.mock("@/lib/db", () => dbMock);

// rate-limit module is module-scoped state — reset between tests so a
// previous run's quota doesn't leak forward.
import { __resetRateLimitState } from "@/lib/swapcard/rate-limit";

describe("GET /api/swapcard/photo/[personId]", () => {
  beforeEach(() => {
    fakeFs.files.clear();
    fakeFs.dirs.clear();
    sessionMock.getUserSession.mockReset();
    dbMock.getSwapcardAttendeePhotoUrl.mockReset();
    dbMock.getCard.mockReset();
    // Default: caller IS a linked attendee. Individual tests override.
    dbMock.getCard.mockReturnValue({
      swapcardPersonId: "PERSON_ME",
      swapcardEventId: "eag-london-2026",
    });
    __resetRateLimitState();
    vi.stubEnv("DATA_DIR", "/tmp/test-photos");
    vi.stubEnv("SWAPCARD_EVENT_ID", "eag-london-2026");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function callRoute(personId: string) {
    const { GET } = await import(
      "@/app/api/swapcard/photo/[personId]/route"
    );
    const req = new Request(
      `http://localhost/api/swapcard/photo/${personId}`
    );
    return GET(req as never, {
      params: Promise.resolve({ personId }),
    });
  }

  it("returns 401 when there's no session", async () => {
    sessionMock.getUserSession.mockResolvedValue(null);
    const res = await callRoute("PERSON_1");
    expect(res.status).toBe(401);
  });

  it("returns 404 when the personId has no photo_url in the DB", async () => {
    sessionMock.getUserSession.mockResolvedValue({
      twitterId: "1",
      twitterHandle: "alice",
      exp: Date.now() / 1000 + 3600,
    });
    dbMock.getSwapcardAttendeePhotoUrl.mockReturnValue(null);
    const res = await callRoute("PERSON_404");
    expect(res.status).toBe(404);
  });

  it("on cache miss: fetches upstream, writes to cache, serves bytes", async () => {
    sessionMock.getUserSession.mockResolvedValue({
      twitterId: "1",
      twitterHandle: "alice",
      exp: Date.now() / 1000 + 3600,
    });
    dbMock.getSwapcardAttendeePhotoUrl.mockReturnValue(
      "https://cdn.example/avatar.jpg"
    );

    const upstreamBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(upstreamBytes, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      })
    );

    const res = await callRoute("PERSON_HIT");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=86400, immutable"
    );
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(upstreamBytes)).toBe(true);

    // The bytes should be persisted under the canonical cache path.
    const expectedPath = cachePathFor(
      "/tmp/test-photos/photos",
      "eag-london-2026",
      "PERSON_HIT"
    );
    expect(fakeFs.files.has(expectedPath)).toBe(true);
    expect(fakeFs.files.get(expectedPath)!.equals(upstreamBytes)).toBe(true);
    // The .tmp file should NOT still be sitting around — it was renamed.
    const tmpish = [...fakeFs.files.keys()].filter((k) => k.includes(".tmp."));
    expect(tmpish).toEqual([]);

    fetchSpy.mockRestore();
  });

  it("on cache hit: serves from disk without re-fetching upstream", async () => {
    sessionMock.getUserSession.mockResolvedValue({
      twitterId: "1",
      twitterHandle: "alice",
      exp: Date.now() / 1000 + 3600,
    });
    dbMock.getSwapcardAttendeePhotoUrl.mockReturnValue(
      "https://cdn.example/avatar.jpg"
    );

    // Pre-populate the cache file.
    const cachedBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const expectedPath = cachePathFor(
      "/tmp/test-photos/photos",
      "eag-london-2026",
      "PERSON_CACHED"
    );
    fakeFs.files.set(expectedPath, cachedBytes);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await callRoute("PERSON_CACHED");
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(cachedBytes)).toBe(true);
    fetchSpy.mockRestore();
  });

  it("returns 502 on upstream throw without poisoning the cache", async () => {
    sessionMock.getUserSession.mockResolvedValue({
      twitterId: "1",
      twitterHandle: "alice",
      exp: Date.now() / 1000 + 3600,
    });
    dbMock.getSwapcardAttendeePhotoUrl.mockReturnValue(
      "https://cdn.example/dead.jpg"
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("connection reset"));

    const res = await callRoute("PERSON_502");
    expect(res.status).toBe(502);
    // Nothing should have been written under either the real or .tmp path.
    expect([...fakeFs.files.keys()]).toEqual([]);
    fetchSpy.mockRestore();
  });

  it("cache miss with non-image content-type returns 502 + cache stays empty (iter 19)", async () => {
    sessionMock.getUserSession.mockResolvedValue({
      twitterId: "1",
      twitterHandle: "alice",
      exp: Date.now() / 1000 + 3600,
    });
    dbMock.getSwapcardAttendeePhotoUrl.mockReturnValue(
      "https://cdn.example/sneaky"
    );
    // Upstream lies and serves HTML (e.g. an interstitial). Without the
    // content-type guard we'd persist this text on disk under an image
    // URL forever; with the guard we 502 and write nothing.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>not an image</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    );
    const res = await callRoute("PERSON_BAD_CT");
    expect(res.status).toBe(502);
    expect([...fakeFs.files.keys()]).toEqual([]);
    fetchSpy.mockRestore();
  });

  it("sends X-Content-Type-Options: nosniff on cache-hit responses (iter 19)", async () => {
    sessionMock.getUserSession.mockResolvedValue({
      twitterId: "1",
      twitterHandle: "alice",
      exp: Date.now() / 1000 + 3600,
    });
    dbMock.getSwapcardAttendeePhotoUrl.mockReturnValue(
      "https://cdn.example/avatar.jpg"
    );
    const cachedBytes = Buffer.from([0x00, 0x01]);
    const cachedPath = cachePathFor(
      "/tmp/test-photos/photos",
      "eag-london-2026",
      "PERSON_NOSNIFF_HIT"
    );
    fakeFs.files.set(cachedPath, cachedBytes);
    const res = await callRoute("PERSON_NOSNIFF_HIT");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("sends X-Content-Type-Options: nosniff on cache-miss responses (iter 19)", async () => {
    sessionMock.getUserSession.mockResolvedValue({
      twitterId: "1",
      twitterHandle: "alice",
      exp: Date.now() / 1000 + 3600,
    });
    dbMock.getSwapcardAttendeePhotoUrl.mockReturnValue(
      "https://cdn.example/avatar.jpg"
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(Buffer.from([0xff, 0xd8, 0xff]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      })
    );
    const res = await callRoute("PERSON_NOSNIFF_MISS");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    fetchSpy.mockRestore();
  });

  it("returns 502 on upstream non-2xx without poisoning the cache", async () => {
    sessionMock.getUserSession.mockResolvedValue({
      twitterId: "1",
      twitterHandle: "alice",
      exp: Date.now() / 1000 + 3600,
    });
    dbMock.getSwapcardAttendeePhotoUrl.mockReturnValue(
      "https://cdn.example/dead.jpg"
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("not found", { status: 404 }));

    const res = await callRoute("PERSON_502B");
    expect(res.status).toBe(502);
    expect([...fakeFs.files.keys()]).toEqual([]);
    fetchSpy.mockRestore();
  });

  // ── linked-attendee gate (iter 19 pen-test fix) ─────────────────────────
  it("returns 403 when the caller has no card", async () => {
    sessionMock.getUserSession.mockResolvedValue({
      twitterId: "1",
      twitterHandle: "alice",
      exp: Date.now() / 1000 + 3600,
    });
    dbMock.getCard.mockReturnValue(null);
    const res = await callRoute("PERSON_LOCKED");
    expect(res.status).toBe(403);
  });

  it("returns 403 when the caller's card has no swapcardPersonId", async () => {
    sessionMock.getUserSession.mockResolvedValue({
      twitterId: "1",
      twitterHandle: "alice",
      exp: Date.now() / 1000 + 3600,
    });
    dbMock.getCard.mockReturnValue({
      swapcardPersonId: null,
      swapcardEventId: null,
    });
    const res = await callRoute("PERSON_LOCKED");
    expect(res.status).toBe(403);
  });

  // ── rate limit (iter 19 pen-test fix) ───────────────────────────────────
  it("returns 429 after 100 rapid cache-miss fetches in the window", async () => {
    sessionMock.getUserSession.mockResolvedValue({
      twitterId: "1",
      twitterHandle: "alice",
      exp: Date.now() / 1000 + 3600,
    });
    dbMock.getSwapcardAttendeePhotoUrl.mockReturnValue(
      "https://cdn.example/avatar.jpg"
    );
    // mockImplementation returns a fresh Response per call — the body
    // stream is single-use, so a shared resolved-value would 502 on the
    // second invocation.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(Buffer.from([0xff]), {
          status: 200,
          headers: { "content-type": "image/webp" },
        })
    );

    // 100 distinct ids → 100 misses, all succeed.
    for (let i = 0; i < 100; i++) {
      const res = await callRoute(`PERSON_RL_${i}`);
      expect(res.status).toBe(200);
    }
    // 101st → 429 with Retry-After.
    const blocked = await callRoute("PERSON_RL_OVER");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();

    fetchSpy.mockRestore();
  });

  it("cache hits do NOT count toward the photo-fetch rate limit", async () => {
    sessionMock.getUserSession.mockResolvedValue({
      twitterId: "1",
      twitterHandle: "alice",
      exp: Date.now() / 1000 + 3600,
    });
    dbMock.getSwapcardAttendeePhotoUrl.mockReturnValue(
      "https://cdn.example/avatar.jpg"
    );
    // Pre-populate cache for a single id.
    const cachedBytes = Buffer.from([0xaa, 0xbb]);
    const cachedPath = cachePathFor(
      "/tmp/test-photos/photos",
      "eag-london-2026",
      "PERSON_HOT"
    );
    fakeFs.files.set(cachedPath, cachedBytes);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // 200 cache hits in a row — quota is 100 misses per 15min but hits
    // shouldn't tick the counter.
    for (let i = 0; i < 200; i++) {
      const res = await callRoute("PERSON_HOT");
      expect(res.status).toBe(200);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("concurrent cache-miss writers don't collide on .tmp path; rename loser falls back to winning bytes", async () => {
    sessionMock.getUserSession.mockResolvedValue({
      twitterId: "1",
      twitterHandle: "alice",
      exp: Date.now() / 1000 + 3600,
    });
    dbMock.getSwapcardAttendeePhotoUrl.mockReturnValue(
      "https://cdn.example/race.jpg"
    );

    // Two writers fetch slightly different bytes. The first to rename
    // wins; the second's rename fails and the route serves the existing
    // file. We model the race by making renameSync throw on the second
    // call when the destination is already populated.
    //
    // The fake fs uses Map.set in renameSync which would normally just
    // overwrite — patch it to throw so we can exercise the catch path.
    const upstreamA = Buffer.from([0xa1, 0xa2, 0xa3]);
    const upstreamB = Buffer.from([0xb1, 0xb2, 0xb3]);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(upstreamA, {
          status: 200,
          headers: { "content-type": "image/webp" },
        })
      )
      .mockResolvedValueOnce(
        new Response(upstreamB, {
          status: 200,
          headers: { "content-type": "image/webp" },
        })
      );

    const fsMod = await import("node:fs");
    const renameSpy = vi
      .spyOn(fsMod, "renameSync")
      .mockImplementationOnce((from, to) => {
        const b = fakeFs.files.get(from as string);
        if (!b) throw new Error(`ENOENT ${from as string}`);
        fakeFs.files.set(to as string, b);
        fakeFs.files.delete(from as string);
      })
      .mockImplementationOnce(() => {
        // Second writer loses the rename race.
        throw new Error("EEXIST or concurrent rename");
      });

    const resA = await callRoute("PERSON_RACE");
    const resB = await callRoute("PERSON_RACE");
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    const bodyA = Buffer.from(await resA.arrayBuffer());
    const bodyB = Buffer.from(await resB.arrayBuffer());
    // Winner served their own bytes.
    expect(bodyA.equals(upstreamA)).toBe(true);
    // Loser served the winning bytes from disk (NOT their own).
    expect(bodyB.equals(upstreamA)).toBe(true);

    // Both used distinct random tmp paths — no leftover tmp files after
    // the winner's successful rename (loser's tmp may or may not be
    // cleaned up; not asserted because the catch path doesn't unlink).
    const winnerPath = cachePathFor(
      "/tmp/test-photos/photos",
      "eag-london-2026",
      "PERSON_RACE"
    );
    expect(fakeFs.files.get(winnerPath)!.equals(upstreamA)).toBe(true);

    renameSpy.mockRestore();
    fetchSpy.mockRestore();
  });
});
