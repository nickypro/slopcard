import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Same DATA_DIR isolation pattern as people-search.test.ts.
vi.hoisted(() => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  process.env.DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "slopcard-interests-test-")
  );
});

interface InsertArgs {
  eventId?: string;
  personId?: string | null;
  firstName: string;
  lastName: string;
  profile: Record<string, unknown>;
  sheetSignature?: string;
}

describe("listAttendeeInterests", () => {
  let listAttendeeInterests: typeof import("@/lib/db").listAttendeeInterests;
  let searchSwapcardAttendees: typeof import("@/lib/db").searchSwapcardAttendees;
  let __resetAttendeeInterestsCache: typeof import("@/lib/db").__resetAttendeeInterestsCache;
  let db: typeof import("@/lib/db").default;

  function insertAttendee(args: InsertArgs): void {
    const ev = args.eventId ?? "evt";
    const sig = args.sheetSignature ?? "sig";
    db.prepare(
      `INSERT INTO swapcard_attendees
         (event_id, person_id, event_people_id, first_name, last_name,
          profile_json, embedding, photo_url, sheet_signature, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      ev,
      args.personId ?? null,
      null,
      args.firstName,
      args.lastName,
      JSON.stringify(args.profile),
      Buffer.alloc(0),
      null,
      sig,
      Date.now()
    );
  }

  beforeAll(async () => {
    const mod = await import("@/lib/db");
    listAttendeeInterests = mod.listAttendeeInterests;
    searchSwapcardAttendees = mod.searchSwapcardAttendees;
    __resetAttendeeInterestsCache = mod.__resetAttendeeInterestsCache;
    db = mod.default;
  });

  beforeEach(() => {
    __resetAttendeeInterestsCache();
  });

  afterEach(() => {
    db.prepare("DELETE FROM swapcard_attendees").run();
    __resetAttendeeInterestsCache();
  });

  it("returns sorted unique interests across attendees", () => {
    insertAttendee({
      personId: "a",
      firstName: "A",
      lastName: "Z",
      profile: { interests: ["AI safety", "Animal welfare"] },
    });
    insertAttendee({
      personId: "b",
      firstName: "B",
      lastName: "Y",
      profile: { interests: ["Biosecurity", "AI safety"] },
    });
    const out = listAttendeeInterests("evt");
    expect(out).toEqual(["AI safety", "Animal welfare", "Biosecurity"]);
  });

  it("dedupes case-insensitively but preserves first-seen casing", () => {
    insertAttendee({
      personId: "a",
      firstName: "A",
      lastName: "Z",
      profile: { interests: ["AI Safety"] },
    });
    insertAttendee({
      personId: "b",
      firstName: "B",
      lastName: "Y",
      profile: { interests: ["ai safety", "Policy"] },
    });
    const out = listAttendeeInterests("evt");
    expect(out).toEqual(["AI Safety", "Policy"]);
  });

  it("skips rows where interests is missing, non-array, or malformed", () => {
    insertAttendee({
      personId: "a",
      firstName: "A",
      lastName: "Z",
      profile: { jobTitle: "no interests at all" },
    });
    insertAttendee({
      personId: "b",
      firstName: "B",
      lastName: "Y",
      profile: { interests: "Policy" },
    });
    insertAttendee({
      personId: "c",
      firstName: "C",
      lastName: "X",
      profile: { interests: ["Policy", "", "  "] },
    });
    const out = listAttendeeInterests("evt");
    expect(out).toEqual(["Policy"]);
  });

  it("isolates results across event_id", () => {
    insertAttendee({
      eventId: "evt-a",
      personId: "x",
      firstName: "A",
      lastName: "Z",
      profile: { interests: ["AI safety"] },
      sheetSignature: "sig-a",
    });
    insertAttendee({
      eventId: "evt-b",
      personId: "y",
      firstName: "B",
      lastName: "Y",
      profile: { interests: ["Biosecurity"] },
      sheetSignature: "sig-b",
    });
    expect(listAttendeeInterests("evt-a")).toEqual(["AI safety"]);
    expect(listAttendeeInterests("evt-b")).toEqual(["Biosecurity"]);
  });

  it("round-trips through searchSwapcardAttendees with causeArea filter", () => {
    insertAttendee({
      personId: "a",
      firstName: "Alice",
      lastName: "Z",
      profile: { interests: ["AI safety", "Policy"] },
    });
    insertAttendee({
      personId: "b",
      firstName: "Bob",
      lastName: "Y",
      profile: { interests: ["Biosecurity"] },
    });
    // Without filter: both surface.
    const all = searchSwapcardAttendees("evt", "", 50, 0);
    expect(all.total).toBe(2);
    // With filter: only the matching attendee.
    const filtered = searchSwapcardAttendees("evt", "", 50, 0, "AI safety");
    expect(filtered.total).toBe(1);
    expect(filtered.results[0].personId).toBe("a");
  });

  it("causeArea filter is case-insensitive", () => {
    insertAttendee({
      personId: "a",
      firstName: "Alice",
      lastName: "Z",
      profile: { interests: ["AI Safety"] },
    });
    const r = searchSwapcardAttendees("evt", "", 50, 0, "ai safety");
    expect(r.total).toBe(1);
  });

  it("causeArea filter composes with query tokens (AND)", () => {
    insertAttendee({
      personId: "a",
      firstName: "Alice",
      lastName: "Z",
      profile: { jobTitle: "Researcher", interests: ["AI safety"] },
    });
    insertAttendee({
      personId: "b",
      firstName: "Alice",
      lastName: "Y",
      profile: { jobTitle: "Founder", interests: ["AI safety"] },
    });
    insertAttendee({
      personId: "c",
      firstName: "Alice",
      lastName: "X",
      profile: { jobTitle: "Researcher", interests: ["Biosecurity"] },
    });
    // "alice" + cause-area "AI safety": three Alices total, two are AI-safety,
    // one is also a Researcher → all three match q="alice", two match c="AI
    // safety", and intersection narrows further when both filters are present.
    const both = searchSwapcardAttendees("evt", "alice researcher", 50, 0, "AI safety");
    expect(both.total).toBe(1);
    expect(both.results[0].personId).toBe("a");
  });

  it("caches result within a sheet signature", () => {
    insertAttendee({
      personId: "a",
      firstName: "A",
      lastName: "Z",
      profile: { interests: ["AI safety"] },
      sheetSignature: "sig-1",
    });
    const first = listAttendeeInterests("evt");
    expect(first).toEqual(["AI safety"]);
    // Sneak a new interest in without rotating the signature; cache should
    // serve the stale (correct) view because the signature is unchanged.
    insertAttendee({
      personId: "b",
      firstName: "B",
      lastName: "Y",
      profile: { interests: ["Policy"] },
      sheetSignature: "sig-1",
    });
    const stillCached = listAttendeeInterests("evt");
    expect(stillCached).toEqual(["AI safety"]);
  });
});
