import { describe, it, expect, vi } from "vitest";

// Isolate this test file's SQLite db under a fresh temp DATA_DIR. Mirrors
// the discover-runs.test.ts setup — see that file for why vi.hoisted +
// require() rather than imports.
vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path");
  process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "slopcard-test-"));
});

import {
  setAttendeeSlots,
  getAttendeeSlots,
  listFreshAttendeeSlotCounts,
} from "@/lib/db";

describe("attendee_slots cache", () => {
  it("setAttendeeSlots round-trips via getAttendeeSlots", () => {
    const slots = JSON.stringify([
      { id: "s1", starts: "2026-05-29T10:00:00+01:00", ends: "2026-05-29T10:30:00+01:00" },
      { id: "s2", starts: "2026-05-29T10:30:00+01:00", ends: "2026-05-29T11:00:00+01:00" },
    ]);
    setAttendeeSlots("ev-rt", "EventPeople_rt1", slots);
    const got = getAttendeeSlots("ev-rt", "EventPeople_rt1", 3600);
    expect(got).not.toBeNull();
    expect(got!.slotsJson).toBe(slots);
    expect(typeof got!.fetchedAt).toBe("number");
  });

  it("upsert: re-running setAttendeeSlots overwrites in place", () => {
    setAttendeeSlots("ev-up", "EventPeople_up1", JSON.stringify([{ id: "a" }]));
    setAttendeeSlots(
      "ev-up",
      "EventPeople_up1",
      JSON.stringify([{ id: "b" }, { id: "c" }])
    );
    const got = getAttendeeSlots("ev-up", "EventPeople_up1", 3600);
    expect(got).not.toBeNull();
    const parsed = JSON.parse(got!.slotsJson);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe("b");
  });

  it("getAttendeeSlots returns null for stale rows", async () => {
    setAttendeeSlots("ev-stale", "EventPeople_stale", JSON.stringify([]));
    // Wait long enough that even with same-ms inserts the row is now
    // older than our TTL. 10ms wall-clock against a 1ms TTL is comfortably
    // outside any CI clock jitter.
    await new Promise((r) => setTimeout(r, 10));
    const got = getAttendeeSlots("ev-stale", "EventPeople_stale", 0.001);
    expect(got).toBeNull();
  });

  it("getAttendeeSlots returns null when no row exists", () => {
    const got = getAttendeeSlots("ev-absent", "EventPeople_nope", 3600);
    expect(got).toBeNull();
  });

  it("listFreshAttendeeSlotCounts returns a Map keyed by eventPeopleId", () => {
    setAttendeeSlots(
      "ev-counts",
      "EventPeople_a",
      JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }])
    );
    setAttendeeSlots("ev-counts", "EventPeople_b", JSON.stringify([{ id: 1 }]));
    setAttendeeSlots("ev-counts", "EventPeople_empty", JSON.stringify([]));
    const counts = listFreshAttendeeSlotCounts(
      "ev-counts",
      ["EventPeople_a", "EventPeople_b", "EventPeople_empty"],
      3600
    );
    expect(counts.get("EventPeople_a")).toBe(3);
    expect(counts.get("EventPeople_b")).toBe(1);
    expect(counts.get("EventPeople_empty")).toBe(0);
  });

  it("listFreshAttendeeSlotCounts excludes stale rows from the map", async () => {
    setAttendeeSlots("ev-mix", "EventPeople_fresh", JSON.stringify([{ id: 1 }]));
    setAttendeeSlots("ev-mix", "EventPeople_old", JSON.stringify([{ id: 1 }]));
    await new Promise((r) => setTimeout(r, 10));
    // 1ms TTL after a 10ms wait — every row is stale → empty map.
    // Sanity check that the SQL cutoff filter is wired (not just relying
    // on getAttendeeSlots' separate staleness branch).
    const counts = listFreshAttendeeSlotCounts(
      "ev-mix",
      ["EventPeople_fresh", "EventPeople_old"],
      0.001
    );
    expect(counts.size).toBe(0);
  });

  it("cross-event isolation: counts and reads are scoped to event_id", () => {
    setAttendeeSlots("ev-x1", "EventPeople_shared", JSON.stringify([{ id: 1 }]));
    setAttendeeSlots(
      "ev-x2",
      "EventPeople_shared",
      JSON.stringify([{ id: 1 }, { id: 2 }])
    );
    // Same event_people_id, different event_ids — must not collide.
    const got1 = getAttendeeSlots("ev-x1", "EventPeople_shared", 3600);
    const got2 = getAttendeeSlots("ev-x2", "EventPeople_shared", 3600);
    expect(JSON.parse(got1!.slotsJson)).toHaveLength(1);
    expect(JSON.parse(got2!.slotsJson)).toHaveLength(2);

    const counts1 = listFreshAttendeeSlotCounts(
      "ev-x1",
      ["EventPeople_shared"],
      3600
    );
    expect(counts1.get("EventPeople_shared")).toBe(1);
    const counts2 = listFreshAttendeeSlotCounts(
      "ev-x2",
      ["EventPeople_shared"],
      3600
    );
    expect(counts2.get("EventPeople_shared")).toBe(2);
  });

  it("empty input array returns an empty Map without crashing", () => {
    const counts = listFreshAttendeeSlotCounts("ev-empty-input", [], 3600);
    expect(counts.size).toBe(0);
  });
});
