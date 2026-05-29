import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Same DATA_DIR isolation pattern as discover-history.test.ts — set the env
// var BEFORE @/lib/db is imported so the SQLite file lives in a temp dir
// scoped to this test file.
vi.hoisted(() => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  process.env.DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "slopcard-people-test-")
  );
});

interface InsertArgs {
  eventId?: string;
  personId?: string | null;
  eventPeopleId?: string | null;
  firstName: string;
  lastName: string;
  profile: Record<string, unknown>;
  photoUrl?: string | null;
  sheetSignature?: string;
}

describe("searchSwapcardAttendees", () => {
  let searchSwapcardAttendees: typeof import("@/lib/db").searchSwapcardAttendees;
  let searchSwapcardAttendeesByCloseness: typeof import("@/lib/db").searchSwapcardAttendeesByCloseness;
  let db: typeof import("@/lib/db").default;

  // Insert a fully synthetic attendee row directly. We don't go through the
  // ingest pipeline because that requires loading the embedding model — a
  // zero-buffer embedding is fine for search-only tests since search ignores
  // it. profile is JSON-encoded to mirror what runIngest writes.
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
      args.eventPeopleId ?? null,
      args.firstName,
      args.lastName,
      JSON.stringify(args.profile),
      Buffer.alloc(0),
      args.photoUrl ?? null,
      sig,
      Date.now()
    );
  }

  beforeAll(async () => {
    const mod = await import("@/lib/db");
    searchSwapcardAttendees = mod.searchSwapcardAttendees;
    searchSwapcardAttendeesByCloseness = mod.searchSwapcardAttendeesByCloseness;
    db = mod.default;
  });

  // Build a fake 4-dim embedding buffer for tests. Real prod uses 384 dims but
  // the helper accepts any size — it reads dim from buffer.length / 4. Keeps
  // the test data readable.
  function makeEmbedding(vals: number[]): Buffer {
    const buf = Buffer.alloc(vals.length * 4);
    for (let i = 0; i < vals.length; i++) buf.writeFloatLE(vals[i], i * 4);
    return buf;
  }

  function insertAttendeeWithEmbedding(
    args: InsertArgs & { embedding: Buffer }
  ): void {
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
      args.eventPeopleId ?? null,
      args.firstName,
      args.lastName,
      JSON.stringify(args.profile),
      args.embedding,
      args.photoUrl ?? null,
      sig,
      Date.now()
    );
  }

  afterEach(() => {
    db.prepare("DELETE FROM swapcard_attendees").run();
  });

  it("empty query returns every attendee, paginated by limit", () => {
    for (let i = 0; i < 5; i++) {
      insertAttendee({
        personId: `p${i}`,
        firstName: `Person${i}`,
        lastName: "X",
        profile: { jobTitle: "", company: "", country: "" },
      });
    }
    const r = searchSwapcardAttendees("evt", "", 3, 0);
    expect(r.total).toBe(5);
    expect(r.results.length).toBe(3);
  });

  it("token search across name finds matches", () => {
    insertAttendee({
      personId: "a",
      firstName: "Alice",
      lastName: "Smith",
      profile: { jobTitle: "Engineer", company: "Acme" },
    });
    insertAttendee({
      personId: "b",
      firstName: "Bob",
      lastName: "Jones",
      profile: { jobTitle: "PM", company: "Other" },
    });
    const r = searchSwapcardAttendees("evt", "alice");
    expect(r.total).toBe(1);
    expect(r.results[0].firstName).toBe("Alice");
  });

  it("token search across jobTitle finds matches", () => {
    insertAttendee({
      personId: "a",
      firstName: "X",
      lastName: "Y",
      profile: { jobTitle: "AI Safety Researcher", company: "Lab" },
    });
    insertAttendee({
      personId: "b",
      firstName: "Z",
      lastName: "W",
      profile: { jobTitle: "Founder", company: "Startup" },
    });
    const r = searchSwapcardAttendees("evt", "researcher");
    expect(r.total).toBe(1);
    expect(r.results[0].personId).toBe("a");
  });

  it("token search across expertise array finds matches", () => {
    insertAttendee({
      personId: "a",
      firstName: "Erin",
      lastName: "K",
      profile: {
        jobTitle: "",
        company: "",
        expertise: ["Animal welfare", "Policy"],
      },
    });
    insertAttendee({
      personId: "b",
      firstName: "Bob",
      lastName: "M",
      profile: {
        jobTitle: "",
        company: "",
        expertise: ["Biosecurity"],
      },
    });
    const r = searchSwapcardAttendees("evt", "animal");
    expect(r.total).toBe(1);
    expect(r.results[0].personId).toBe("a");
  });

  it("token search across biography finds matches", () => {
    insertAttendee({
      personId: "a",
      firstName: "X",
      lastName: "Y",
      profile: { biography: "Working on mechanistic interpretability." },
    });
    insertAttendee({
      personId: "b",
      firstName: "Z",
      lastName: "W",
      profile: { biography: "Operations role at a nonprofit." },
    });
    const r = searchSwapcardAttendees("evt", "interpretability");
    expect(r.total).toBe(1);
    expect(r.results[0].personId).toBe("a");
  });

  it("is case-insensitive across all columns", () => {
    insertAttendee({
      personId: "a",
      firstName: "Aaron",
      lastName: "Bell",
      profile: {
        jobTitle: "Director",
        company: "OpenPhil",
        biography: "Grants and Research.",
        expertise: ["Effective Altruism"],
      },
    });
    expect(searchSwapcardAttendees("evt", "AARON").total).toBe(1);
    expect(searchSwapcardAttendees("evt", "director").total).toBe(1);
    expect(searchSwapcardAttendees("evt", "OPENPHIL").total).toBe(1);
    expect(searchSwapcardAttendees("evt", "altruism").total).toBe(1);
    expect(searchSwapcardAttendees("evt", "research").total).toBe(1);
  });

  it("multi-token query requires all tokens to match somewhere (AND)", () => {
    insertAttendee({
      personId: "a",
      firstName: "Alice",
      lastName: "Smith",
      profile: { jobTitle: "Engineer", company: "Anthropic" },
    });
    insertAttendee({
      personId: "b",
      firstName: "Alice",
      lastName: "Jones",
      profile: { jobTitle: "Designer", company: "Other" },
    });
    // "alice anthropic" — both tokens must appear. Only row a satisfies both.
    const r = searchSwapcardAttendees("evt", "alice anthropic");
    expect(r.total).toBe(1);
    expect(r.results[0].personId).toBe("a");
  });

  it("ranks prefix matches on full name first", () => {
    // Inserting in reverse-alphabetical order to confirm the rank reorders
    // — natural ordering would give Calista before Alice.
    insertAttendee({
      personId: "c",
      firstName: "Calista",
      lastName: "Alimov",
      profile: { jobTitle: "" },
    });
    insertAttendee({
      personId: "a",
      firstName: "Alice",
      lastName: "Smith",
      profile: { jobTitle: "" },
    });
    const r = searchSwapcardAttendees("evt", "ali");
    expect(r.total).toBe(2);
    // "Alice" prefixes — should sort before "Calista Alimov" (substring hit).
    expect(r.results[0].personId).toBe("a");
    expect(r.results[1].personId).toBe("c");
  });

  it("returns total distinct from results.length when paginated", () => {
    for (let i = 0; i < 7; i++) {
      insertAttendee({
        personId: `p${i}`,
        firstName: "Match",
        lastName: `Row${i}`,
        profile: { jobTitle: "" },
      });
    }
    const r = searchSwapcardAttendees("evt", "match", 3, 0);
    expect(r.total).toBe(7);
    expect(r.results.length).toBe(3);
  });

  it("limit + offset paginate consistently", () => {
    for (let i = 0; i < 5; i++) {
      insertAttendee({
        personId: `p${i}`,
        firstName: `A${i}`,
        lastName: "Z",
        profile: { jobTitle: "" },
      });
    }
    const page1 = searchSwapcardAttendees("evt", "", 2, 0);
    const page2 = searchSwapcardAttendees("evt", "", 2, 2);
    const page3 = searchSwapcardAttendees("evt", "", 2, 4);
    expect(page1.results.map((r) => r.personId)).toEqual(["p0", "p1"]);
    expect(page2.results.map((r) => r.personId)).toEqual(["p2", "p3"]);
    expect(page3.results.map((r) => r.personId)).toEqual(["p4"]);
    expect(page1.total).toBe(5);
  });

  it("isolates results across event_id", () => {
    insertAttendee({
      eventId: "evt-a",
      personId: "x",
      firstName: "Shared",
      lastName: "Name",
      profile: { jobTitle: "" },
    });
    insertAttendee({
      eventId: "evt-b",
      personId: "y",
      firstName: "Shared",
      lastName: "Name",
      profile: { jobTitle: "" },
    });
    const a = searchSwapcardAttendees("evt-a", "shared");
    const b = searchSwapcardAttendees("evt-b", "shared");
    expect(a.total).toBe(1);
    expect(b.total).toBe(1);
    expect(a.results[0].personId).toBe("x");
    expect(b.results[0].personId).toBe("y");
  });

  // ── iter 19 pen-test DOS hardening ─────────────────────────────────────
  it("truncates a >100-char raw query so long inputs don't blow up LIKE", () => {
    // Bio contains the exact prefix the truncation produces. Without
    // truncation, the full 200-char single-token LIKE wouldn't match;
    // after truncation to 100 chars, the prefix matches the biography.
    const prefix = "alice".padEnd(100, "x");
    insertAttendee({
      personId: "a",
      firstName: "First",
      lastName: "Last",
      profile: { jobTitle: "", biography: prefix },
    });
    // Query = the prefix + an extra 100 chars of "y" suffix. After
    // truncation, only the first 100 chars (== `prefix`) survive, so the
    // LIKE pattern matches the biography.
    const longQ = prefix + "y".repeat(100);
    expect(longQ.length).toBe(200);
    const r = searchSwapcardAttendees("evt", longQ);
    expect(r.total).toBe(1);
    // Sanity check: without truncation the bigger query wouldn't match
    // (the biography doesn't contain any "y"s). So a hit here proves
    // the truncation actually fired.
    expect(r.results[0].personId).toBe("a");
  });

  it("strips %/_ wildcards from each token so they can't force matches", () => {
    insertAttendee({
      personId: "a",
      firstName: "Alice",
      lastName: "Smith",
      profile: { jobTitle: "" },
    });
    insertAttendee({
      personId: "b",
      firstName: "Bob",
      lastName: "Jones",
      profile: { jobTitle: "" },
    });
    // A bare `%` would match every row under naive LIKE wrapping. After
    // stripping the wildcard the token collapses to empty → empty-query
    // path returns all rows alphabetically.
    const r = searchSwapcardAttendees("evt", "%");
    expect(r.total).toBe(2);
    // Tokens with embedded wildcards still match the literal substring
    // they're left with. "ali%ce" → "alice" (after strip) → row a only.
    const r2 = searchSwapcardAttendees("evt", "ali%ce");
    expect(r2.total).toBe(1);
    expect(r2.results[0].personId).toBe("a");
  });

  it("caps token count at 8 so a 50-token query doesn't fan out clauses", () => {
    insertAttendee({
      personId: "a",
      firstName: "Alice",
      lastName: "Smith",
      profile: { jobTitle: "Engineer", company: "Anthropic" },
    });
    // 9 tokens, each substring-present in row a's name/jobTitle/company.
    // The 9th ("zzzzzzz") would filter row a out under naive AND fanout.
    // With the cap at 8, the trailing non-matching token is dropped, so
    // row a still matches.
    const q = "ali sm en an alic smi engi anth zzzzzzz";
    const r = searchSwapcardAttendees("evt", q);
    expect(r.total).toBe(1);
  });

  it("projects swapcardUrl and hasPhoto from the row", () => {
    insertAttendee({
      personId: "a",
      firstName: "P",
      lastName: "Q",
      profile: {
        jobTitle: "Eng",
        company: "Co",
        country: "UK",
        swapcardUrl: "https://app.swapcard.com/event/x/person/y",
      },
      photoUrl: "https://cdn.example.com/photo.jpg",
    });
    insertAttendee({
      personId: "b",
      firstName: "R",
      lastName: "S",
      profile: { jobTitle: "" },
      photoUrl: null,
    });
    const r = searchSwapcardAttendees("evt", "");
    const a = r.results.find((x) => x.personId === "a")!;
    const b = r.results.find((x) => x.personId === "b")!;
    expect(a.hasPhoto).toBe(true);
    expect(a.swapcardUrl).toBe("https://app.swapcard.com/event/x/person/y");
    expect(a.jobTitle).toBe("Eng");
    expect(a.company).toBe("Co");
    expect(a.country).toBe("UK");
    expect(b.hasPhoto).toBe(false);
    expect(b.swapcardUrl).toBe("");
  });

  describe("swapcardUrl fallback in projection", () => {
    it("synthesizes a swapcard.com URL from event_people_id when profile has no swapcardUrl", () => {
      const oldSlug = process.env.SWAPCARD_EVENT_SLUG;
      process.env.SWAPCARD_EVENT_SLUG = "eag-london";
      // Stub-shaped row: empty swapcardUrl in profile, event_people_id set.
      insertAttendee({
        eventPeopleId: "RXZlbnRQZW9wbGVfNDU4MzEzMjA=",
        firstName: "Stub",
        lastName: "Person",
        profile: { jobTitle: "", swapcardUrl: "" },
      });
      const r = searchSwapcardAttendees("evt", "");
      const row = r.results.find((x) => x.firstName === "Stub")!;
      expect(row.swapcardUrl).toBe(
        "https://app.swapcard.com/event/eag-london/person/RXZlbnRQZW9wbGVfNDU4MzEzMjA%3D"
      );
      process.env.SWAPCARD_EVENT_SLUG = oldSlug;
    });

    it("prefers an explicit swapcardUrl from the sheet over the synthesized fallback", () => {
      insertAttendee({
        personId: "p1",
        eventPeopleId: "RXZlbnRQZW9wbGVfWA==",
        firstName: "Real",
        lastName: "Sheet",
        profile: {
          jobTitle: "",
          swapcardUrl: "https://app.swapcard.com/event/foo/person/CommunityProfile_abc",
        },
      });
      const r = searchSwapcardAttendees("evt", "");
      const row = r.results.find((x) => x.firstName === "Real")!;
      expect(row.swapcardUrl).toBe(
        "https://app.swapcard.com/event/foo/person/CommunityProfile_abc"
      );
    });

    it("does NOT synthesize a URL for true orphans (no event_people_id at all)", () => {
      insertAttendee({
        firstName: "Orphan",
        lastName: "Row",
        profile: { jobTitle: "", swapcardUrl: "" },
      });
      const r = searchSwapcardAttendees("evt", "");
      const row = r.results.find((x) => x.firstName === "Orphan")!;
      expect(row.swapcardUrl).toBe("");
    });
  });

  describe("matcher helpers (iter 30)", () => {
    it("listSwapcardAttendeeNameRows includes rows with NULL person_id", async () => {
      const mod = await import("@/lib/db");
      const listSwapcardAttendeeNameRows = mod.listSwapcardAttendeeNameRows;
      insertAttendee({
        personId: "p-has",
        firstName: "Has",
        lastName: "ID",
        profile: {},
      });
      insertAttendee({
        firstName: "Null",
        lastName: "ID",
        profile: {},
      });
      const rows = listSwapcardAttendeeNameRows("evt");
      expect(rows.length).toBe(2);
      expect(rows.some((r) => r.firstName === "Has" && r.personId === "p-has")).toBe(true);
      expect(rows.some((r) => r.firstName === "Null" && r.personId === null)).toBe(true);
      expect(rows.every((r) => typeof r.id === "number" && r.id > 0)).toBe(true);
    });

    it("listSwapcardAttendeeNameRows projects company from profile_json", async () => {
      const mod = await import("@/lib/db");
      insertAttendee({
        personId: "p-co",
        firstName: "Co",
        lastName: "Has",
        profile: { company: "Longview Philanthropy" },
      });
      insertAttendee({
        firstName: "Co",
        lastName: "Blank",
        profile: { company: "" },
      });
      insertAttendee({
        firstName: "Co",
        lastName: "Missing",
        profile: {}, // no company key at all
      });
      const rows = mod.listSwapcardAttendeeNameRows("evt");
      expect(
        rows.find((r) => r.lastName === "Has")!.company
      ).toBe("Longview Philanthropy");
      expect(rows.find((r) => r.lastName === "Blank")!.company).toBe("");
      // Missing key projects as empty string (COALESCE on the SQL side).
      expect(rows.find((r) => r.lastName === "Missing")!.company).toBe("");
    });

    it("setSwapcardAttendeeEventPeopleAndPhotoByRowId attaches event_people_id by row id (not person_id)", async () => {
      const mod = await import("@/lib/db");
      insertAttendee({
        firstName: "By",
        lastName: "RowId",
        profile: { jobTitle: "" },
      });
      const rows = mod.listSwapcardAttendeeNameRows("evt");
      const row = rows.find((r) => r.firstName === "By")!;
      mod.setSwapcardAttendeeEventPeopleAndPhotoByRowId(
        row.id,
        "RXZlbnRQZW9wbGVfWFhY",
        "https://example.com/photo.jpg"
      );
      const after = mod.listSwapcardAttendeeNameRows("evt").find((r) => r.id === row.id)!;
      expect(after.eventPeopleId).toBe("RXZlbnRQZW9wbGVfWFhY");
    });

    it("setSwapcardAttendeeEventPeopleAndPhotoByRowId preserves existing photo on null arg (COALESCE)", async () => {
      const mod = await import("@/lib/db");
      insertAttendee({
        firstName: "Photo",
        lastName: "Keep",
        profile: { jobTitle: "" },
        photoUrl: "https://existing/pic.jpg",
      });
      const row = mod
        .listSwapcardAttendeeNameRows("evt")
        .find((r) => r.firstName === "Photo")!;
      mod.setSwapcardAttendeeEventPeopleAndPhotoByRowId(row.id, "EP1", null);
      // Re-read full row to inspect photo_url
      const full = db
        .prepare("SELECT photo_url FROM swapcard_attendees WHERE id = ?")
        .get(row.id) as { photo_url: string };
      expect(full.photo_url).toBe("https://existing/pic.jpg");
    });

    it("deleteSwapcardAttendeeByRowId removes the row", async () => {
      const mod = await import("@/lib/db");
      insertAttendee({
        firstName: "Delete",
        lastName: "Me",
        profile: {},
      });
      const row = mod
        .listSwapcardAttendeeNameRows("evt")
        .find((r) => r.firstName === "Delete")!;
      mod.deleteSwapcardAttendeeByRowId(row.id);
      const after = mod
        .listSwapcardAttendeeNameRows("evt")
        .find((r) => r.id === row.id);
      expect(after).toBeUndefined();
    });
  });

  describe("searchSwapcardAttendeesByCloseness", () => {
    // We use 2-dim vectors so the cosine math is trivially predictable:
    //   me = [1, 0]
    //   alice = [1, 0]   → dot = 1.0 (closest)
    //   bob   = [0.5, 0.5] → dot = 0.5
    //   carol = [0, 1]   → dot = 0 (farthest)
    //   stub  = [0, 0]   → dot = 0 (tied with carol, alphabetical break)
    const ME_VEC = makeEmbedding([1, 0]);

    function seed(): void {
      insertAttendeeWithEmbedding({
        personId: "alice",
        firstName: "Alice",
        lastName: "A",
        profile: { jobTitle: "Eng" },
        embedding: makeEmbedding([1, 0]),
      });
      insertAttendeeWithEmbedding({
        personId: "bob",
        firstName: "Bob",
        lastName: "B",
        profile: { jobTitle: "PM" },
        embedding: makeEmbedding([0.5, 0.5]),
      });
      insertAttendeeWithEmbedding({
        personId: "carol",
        firstName: "Carol",
        lastName: "C",
        profile: { jobTitle: "" },
        embedding: makeEmbedding([0, 1]),
      });
      insertAttendeeWithEmbedding({
        personId: "stub",
        firstName: "Stub",
        lastName: "S",
        profile: {},
        embedding: makeEmbedding([0, 0]),
      });
    }

    it("orders globally by cosine descending (not within-page)", () => {
      seed();
      const r = searchSwapcardAttendeesByCloseness("evt", "", ME_VEC, 10, 0);
      expect(r.total).toBe(4);
      expect(r.results.map((x) => x.personId)).toEqual([
        "alice",
        "bob",
        "carol", // tied with stub at 0.0, alphabetical break
        "stub",
      ]);
    });

    it("pagination is consistent — page 2 continues where page 1 left off", () => {
      seed();
      const p1 = searchSwapcardAttendeesByCloseness("evt", "", ME_VEC, 2, 0);
      const p2 = searchSwapcardAttendeesByCloseness("evt", "", ME_VEC, 2, 2);
      const all = [...p1.results, ...p2.results].map((x) => x.personId);
      expect(all).toEqual(["alice", "bob", "carol", "stub"]);
      expect(p1.total).toBe(4);
      expect(p2.total).toBe(4);
    });

    it("respects query filter — only matching rows are scored", () => {
      seed();
      // Only Alice's profile has "Eng" in jobTitle. Bob+Carol+Stub filtered out.
      const r = searchSwapcardAttendeesByCloseness(
        "evt",
        "Eng",
        ME_VEC,
        10,
        0
      );
      expect(r.total).toBe(1);
      expect(r.results.map((x) => x.personId)).toEqual(["alice"]);
    });

    it("respects cause-area filter", () => {
      insertAttendeeWithEmbedding({
        personId: "ai-1",
        firstName: "A",
        lastName: "X",
        profile: { interests: ["AI safety"] },
        embedding: makeEmbedding([1, 0]),
      });
      insertAttendeeWithEmbedding({
        personId: "gh-1",
        firstName: "B",
        lastName: "Y",
        profile: { interests: ["Global health"] },
        embedding: makeEmbedding([0.9, 0]),
      });
      const r = searchSwapcardAttendeesByCloseness(
        "evt",
        "",
        ME_VEC,
        10,
        0,
        "AI safety"
      );
      expect(r.total).toBe(1);
      expect(r.results[0].personId).toBe("ai-1");
    });

    it("zero requester embedding collapses scores to 0 → alphabetical fallback", () => {
      // Stub linkage edge case: requester linked to a person whose embedding
      // is the zero buffer. cosine is 0 against everyone → tie → alphabetical.
      seed();
      const ZERO = makeEmbedding([0, 0]);
      const r = searchSwapcardAttendeesByCloseness("evt", "", ZERO, 10, 0);
      expect(r.results.map((x) => x.personId)).toEqual([
        "alice",
        "bob",
        "carol",
        "stub",
      ]);
    });

    it("empty cause-area string is treated as no filter (matches search variant)", () => {
      seed();
      const r1 = searchSwapcardAttendeesByCloseness("evt", "", ME_VEC, 10, 0);
      const r2 = searchSwapcardAttendeesByCloseness(
        "evt",
        "",
        ME_VEC,
        10,
        0,
        ""
      );
      expect(r1.total).toBe(r2.total);
    });
  });
});
