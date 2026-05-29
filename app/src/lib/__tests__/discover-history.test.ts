import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Same pattern as discover-runs.test.ts — set DATA_DIR to a per-test temp dir
// BEFORE @/lib/db is imported, so the SQLite file lives in isolation.
vi.hoisted(() => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  process.env.DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "slopcard-history-test-")
  );
});

describe("listDiscoverRunsForHandle", () => {
  let insertDiscoverRun: typeof import("@/lib/db").insertDiscoverRun;
  let listDiscoverRunsForHandle: typeof import("@/lib/db").listDiscoverRunsForHandle;
  let db: typeof import("@/lib/db").default;

  beforeAll(async () => {
    const mod = await import("@/lib/db");
    insertDiscoverRun = mod.insertDiscoverRun;
    listDiscoverRunsForHandle = mod.listDiscoverRunsForHandle;
    db = mod.default;
  });

  afterEach(() => {
    db.prepare("DELETE FROM swapcard_discover_runs").run();
  });

  it("returns empty when the handle has no runs", () => {
    expect(listDiscoverRunsForHandle("nobody")).toEqual([]);
  });

  it("returns runs newest-first and parses summary fields", () => {
    insertDiscoverRun(
      "alice",
      "evt",
      "sig-a",
      JSON.stringify({
        recommendations: new Array(7).fill({ rating: 5 }),
        totalAttendees: 2200,
      })
    );
    insertDiscoverRun(
      "alice",
      "evt",
      "sig-b",
      JSON.stringify({
        recommendations: new Array(25).fill({ rating: 4 }),
        totalAttendees: 2300,
      })
    );
    const runs = listDiscoverRunsForHandle("alice");
    expect(runs.length).toBe(2);
    expect(runs[0].recommendationCount).toBe(25);
    expect(runs[0].totalAttendees).toBe(2300);
    expect(runs[1].recommendationCount).toBe(7);
    expect(runs[1].totalAttendees).toBe(2200);
  });

  it("is case-insensitive on handle (matches insert lowercasing)", () => {
    insertDiscoverRun(
      "BobCase",
      "evt",
      "sig",
      JSON.stringify({ recommendations: [], totalAttendees: 10 })
    );
    expect(listDiscoverRunsForHandle("BOBCASE").length).toBe(1);
    expect(listDiscoverRunsForHandle("bobcase").length).toBe(1);
  });

  it("respects the limit argument", () => {
    for (let i = 0; i < 5; i++) {
      insertDiscoverRun(
        "carla",
        "evt",
        `sig-${i}`,
        JSON.stringify({ recommendations: [], totalAttendees: i })
      );
    }
    expect(listDiscoverRunsForHandle("carla", 2).length).toBe(2);
    expect(listDiscoverRunsForHandle("carla", 10).length).toBe(5);
  });

  it("defaults to zero counts when payload JSON is malformed", () => {
    insertDiscoverRun("dave", "evt", "sig", "{not json");
    const runs = listDiscoverRunsForHandle("dave");
    expect(runs[0].recommendationCount).toBe(0);
    expect(runs[0].totalAttendees).toBe(0);
  });

  it("does not leak runs from one handle to another", () => {
    insertDiscoverRun(
      "eve",
      "evt",
      "sig",
      JSON.stringify({ recommendations: [], totalAttendees: 0 })
    );
    expect(listDiscoverRunsForHandle("mallory")).toEqual([]);
  });
});
