import { describe, it, expect, vi } from "vitest";

// Isolate this test file's SQLite db under a fresh temp DATA_DIR. Same setup
// pattern as attendee-slots.test.ts / discover-runs.test.ts — vi.hoisted +
// require() so the env var is set before db.ts loads.
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
  getEventSessionsFetchedAt,
  listEventSessions,
  replaceEventSessions,
} from "@/lib/db";
import type { ScrapedSession } from "@/lib/swapcard/scrape-agenda-events";

function makeSession(
  overrides: Partial<ScrapedSession> & Pick<ScrapedSession, "planningId" | "beginsAt">
): ScrapedSession {
  return {
    planningId: overrides.planningId,
    title: overrides.title ?? "Untitled",
    beginsAt: overrides.beginsAt,
    endsAt: overrides.endsAt ?? overrides.beginsAt,
    place: overrides.place ?? "",
    format: overrides.format ?? "PHYSICAL",
    categories: overrides.categories ?? [],
    description: overrides.description ?? "",
    maxSeats: overrides.maxSeats ?? null,
    remainingSeats: overrides.remainingSeats ?? null,
    visibility: overrides.visibility ?? "PUBLIC",
    speakers: overrides.speakers ?? [],
  };
}

describe("event_sessions cache", () => {
  it("replaceEventSessions round-trips via listEventSessions, preserving payload fields", () => {
    const sessions: ScrapedSession[] = [
      makeSession({
        planningId: "P1",
        beginsAt: "2026-05-29T09:00:00+01:00",
        endsAt: "2026-05-29T10:00:00+01:00",
        title: "Opening",
        place: "Main Hall",
        format: "PHYSICAL",
        categories: [{ id: "C1", name: "Plenary" }],
        speakers: [
          {
            eventPeopleId: "EventPeople_1",
            firstName: "Alice",
            lastName: "Smith",
            organization: "Anthropic",
            photoUrl: null,
          },
        ],
      }),
    ];
    replaceEventSessions("ev-rt", sessions);

    const got = listEventSessions("ev-rt");
    expect(got).toHaveLength(1);
    // Full ScrapedSession round-trips because payload_json is the source of
    // truth, not the denormalised columns.
    expect(got[0]).toEqual(sessions[0]);
  });

  it("atomic replace clears prior rows for the same event", () => {
    replaceEventSessions("ev-replace", [
      makeSession({
        planningId: "P_OLD_1",
        beginsAt: "2026-05-29T09:00:00+01:00",
      }),
      makeSession({
        planningId: "P_OLD_2",
        beginsAt: "2026-05-29T10:00:00+01:00",
      }),
    ]);
    expect(listEventSessions("ev-replace")).toHaveLength(2);

    replaceEventSessions("ev-replace", [
      makeSession({
        planningId: "P_NEW_1",
        beginsAt: "2026-05-30T09:00:00+01:00",
      }),
    ]);
    const got = listEventSessions("ev-replace");
    expect(got).toHaveLength(1);
    expect(got[0].planningId).toBe("P_NEW_1");
  });

  it("listEventSessions orders by begins_at then planning_id", () => {
    // Intentionally insert out-of-order; we expect SQL to sort them.
    replaceEventSessions("ev-order", [
      makeSession({
        planningId: "P_LATE",
        beginsAt: "2026-05-29T11:00:00+01:00",
      }),
      // Two sessions sharing the same start time — ties break by planning_id ASC.
      makeSession({
        planningId: "P_TIE_B",
        beginsAt: "2026-05-29T09:00:00+01:00",
      }),
      makeSession({
        planningId: "P_TIE_A",
        beginsAt: "2026-05-29T09:00:00+01:00",
      }),
      makeSession({
        planningId: "P_MID",
        beginsAt: "2026-05-29T10:00:00+01:00",
      }),
    ]);
    const got = listEventSessions("ev-order");
    expect(got.map((s) => s.planningId)).toEqual([
      "P_TIE_A",
      "P_TIE_B",
      "P_MID",
      "P_LATE",
    ]);
  });

  it("cross-event isolation: listEventSessions scoped to event_id", () => {
    replaceEventSessions("ev-iso-1", [
      makeSession({
        planningId: "P_ONE",
        beginsAt: "2026-05-29T09:00:00+01:00",
      }),
    ]);
    replaceEventSessions("ev-iso-2", [
      makeSession({
        planningId: "P_TWO",
        beginsAt: "2026-05-29T09:00:00+01:00",
      }),
      makeSession({
        planningId: "P_THREE",
        beginsAt: "2026-05-29T10:00:00+01:00",
      }),
    ]);
    expect(listEventSessions("ev-iso-1").map((s) => s.planningId)).toEqual([
      "P_ONE",
    ]);
    expect(listEventSessions("ev-iso-2").map((s) => s.planningId)).toEqual([
      "P_TWO",
      "P_THREE",
    ]);
  });

  it("getEventSessionsFetchedAt returns null when no rows cached, otherwise a recent timestamp", () => {
    expect(getEventSessionsFetchedAt("ev-fa-empty")).toBeNull();

    const before = Date.now();
    replaceEventSessions("ev-fa", [
      makeSession({
        planningId: "P_FA",
        beginsAt: "2026-05-29T09:00:00+01:00",
      }),
    ]);
    const after = Date.now();
    const ts = getEventSessionsFetchedAt("ev-fa");
    expect(ts).not.toBeNull();
    expect(ts!).toBeGreaterThanOrEqual(before);
    expect(ts!).toBeLessThanOrEqual(after);
  });

  it("getEventSessionsFetchedAt reflects the most-recent replace", async () => {
    replaceEventSessions("ev-fa-recent", [
      makeSession({
        planningId: "P_FA1",
        beginsAt: "2026-05-29T09:00:00+01:00",
      }),
    ]);
    const first = getEventSessionsFetchedAt("ev-fa-recent")!;
    // Wait long enough that the second replace lands on a later millisecond.
    await new Promise((r) => setTimeout(r, 5));
    replaceEventSessions("ev-fa-recent", [
      makeSession({
        planningId: "P_FA2",
        beginsAt: "2026-05-29T09:00:00+01:00",
      }),
    ]);
    const second = getEventSessionsFetchedAt("ev-fa-recent")!;
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it("replaceEventSessions with empty array clears the event", () => {
    replaceEventSessions("ev-empty", [
      makeSession({
        planningId: "P_EMPTY",
        beginsAt: "2026-05-29T09:00:00+01:00",
      }),
    ]);
    expect(listEventSessions("ev-empty")).toHaveLength(1);
    replaceEventSessions("ev-empty", []);
    expect(listEventSessions("ev-empty")).toHaveLength(0);
    expect(getEventSessionsFetchedAt("ev-empty")).toBeNull();
  });
});
