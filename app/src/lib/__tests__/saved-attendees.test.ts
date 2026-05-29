import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Per-file DATA_DIR isolation — same vi.hoisted + require() dance as the
// other db tests. The SQLite file gets a fresh temp dir scoped to this run.
vi.hoisted(() => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  process.env.DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "slopcard-saved-test-")
  );
});

interface InsertArgs {
  eventId?: string;
  personId?: string | null;
  eventPeopleId?: string | null;
  firstName: string;
  lastName: string;
  profile?: Record<string, unknown>;
  photoUrl?: string | null;
  sheetSignature?: string;
}

describe("listSavedAttendees", () => {
  let listSavedAttendees: typeof import("@/lib/db").listSavedAttendees;
  let setAttendeeSlots: typeof import("@/lib/db").setAttendeeSlots;
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
      args.eventPeopleId ?? null,
      args.firstName,
      args.lastName,
      JSON.stringify(args.profile ?? {}),
      Buffer.alloc(0),
      args.photoUrl ?? null,
      sig,
      Date.now()
    );
  }

  beforeAll(async () => {
    const mod = await import("@/lib/db");
    listSavedAttendees = mod.listSavedAttendees;
    setAttendeeSlots = mod.setAttendeeSlots;
    db = mod.default;
  });

  afterEach(() => {
    db.prepare("DELETE FROM swapcard_attendees").run();
    db.prepare("DELETE FROM attendee_slots").run();
  });

  it("returns empty when called with no IDs", () => {
    expect(listSavedAttendees("evt", [], 3600)).toEqual([]);
  });

  it("resolves both person_id and event_people_id lookups in one mixed query", () => {
    // One row addressable only by person_id, one only by event_people_id.
    insertAttendee({
      personId: "CommunityProfile_1",
      firstName: "Alice",
      lastName: "Smith",
      profile: { jobTitle: "Eng" },
    });
    insertAttendee({
      eventPeopleId: "EventPeople_2",
      firstName: "Bob",
      lastName: "Jones",
      profile: { jobTitle: "PM" },
    });
    const out = listSavedAttendees(
      "evt",
      ["CommunityProfile_1", "EventPeople_2"],
      3600
    );
    expect(out).toHaveLength(2);
    expect(out[0].firstName).toBe("Alice");
    expect(out[1].firstName).toBe("Bob");
  });

  it("preserves input order", () => {
    insertAttendee({
      personId: "p1",
      firstName: "Alice",
      lastName: "Smith",
    });
    insertAttendee({
      personId: "p2",
      firstName: "Bob",
      lastName: "Jones",
    });
    insertAttendee({
      personId: "p3",
      firstName: "Carol",
      lastName: "Brown",
    });
    // Reverse alphabetical order — would be ABC sorted, but we expect the
    // input order to win.
    const out = listSavedAttendees("evt", ["p3", "p1", "p2"], 3600);
    expect(out.map((r) => r.firstName)).toEqual(["Carol", "Alice", "Bob"]);
  });

  it("skips IDs that don't match a row", () => {
    insertAttendee({
      personId: "p1",
      firstName: "Alice",
      lastName: "Smith",
    });
    const out = listSavedAttendees(
      "evt",
      ["does-not-exist", "p1", "also-missing"],
      3600
    );
    expect(out).toHaveLength(1);
    expect(out[0].firstName).toBe("Alice");
  });

  it("attaches slots only when fresh", async () => {
    insertAttendee({
      personId: "p-fresh",
      eventPeopleId: "EventPeople_fresh",
      firstName: "Fresh",
      lastName: "Person",
    });
    insertAttendee({
      personId: "p-stale",
      eventPeopleId: "EventPeople_stale",
      firstName: "Stale",
      lastName: "Person",
    });
    setAttendeeSlots(
      "evt",
      "EventPeople_fresh",
      JSON.stringify([
        { id: "s1", starts: "2026-05-29T10:00:00+01:00", ends: "x" },
        { id: "s2", starts: "2026-05-29T10:30:00+01:00", ends: "x" },
      ])
    );
    setAttendeeSlots(
      "evt",
      "EventPeople_stale",
      JSON.stringify([
        { id: "s1", starts: "2026-05-29T11:00:00+01:00", ends: "x" },
      ])
    );
    // Wait long enough that the 1ms TTL renders both rows stale, then bump
    // only the fresh row's fetched_at back to "now" so the SQL cutoff
    // accepts it. Mirrors the trick used in attendee-slots.test.ts.
    await new Promise((r) => setTimeout(r, 10));
    setAttendeeSlots(
      "evt",
      "EventPeople_fresh",
      JSON.stringify([
        { id: "s1", starts: "2026-05-29T10:00:00+01:00", ends: "x" },
        { id: "s2", starts: "2026-05-29T10:30:00+01:00", ends: "x" },
      ])
    );
    const out = listSavedAttendees("evt", ["p-fresh", "p-stale"], 0.005);
    const fresh = out.find((r) => r.firstName === "Fresh");
    const stale = out.find((r) => r.firstName === "Stale");
    expect(fresh?.slotStarts).toEqual([
      "2026-05-29T10:00:00+01:00",
      "2026-05-29T10:30:00+01:00",
    ]);
    expect(stale?.slotStarts).toEqual([]);
  });

  it("skips slot lookup gracefully when a row has no event_people_id", () => {
    insertAttendee({
      personId: "p-no-ep",
      eventPeopleId: null,
      firstName: "No",
      lastName: "EventPeople",
    });
    // Even though there's a slot row keyed by some other EP id, our row
    // has no event_people_id, so slotStarts must be empty without crashing.
    setAttendeeSlots(
      "evt",
      "EventPeople_unrelated",
      JSON.stringify([{ id: "s1", starts: "x", ends: "y" }])
    );
    const out = listSavedAttendees("evt", ["p-no-ep"], 3600);
    expect(out).toHaveLength(1);
    expect(out[0].slotStarts).toEqual([]);
  });

  it("isolates results across event_id", () => {
    insertAttendee({
      eventId: "evt-a",
      personId: "shared",
      firstName: "Alice",
      lastName: "A",
    });
    insertAttendee({
      eventId: "evt-b",
      personId: "shared",
      firstName: "Bob",
      lastName: "B",
    });
    const a = listSavedAttendees("evt-a", ["shared"], 3600);
    const b = listSavedAttendees("evt-b", ["shared"], 3600);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].firstName).toBe("Alice");
    expect(b[0].firstName).toBe("Bob");
  });

  it("returns empty slotStarts when row has no slot cache entry", () => {
    insertAttendee({
      personId: "p1",
      eventPeopleId: "EventPeople_no_slots",
      firstName: "Alice",
      lastName: "Smith",
    });
    const out = listSavedAttendees("evt", ["p1"], 3600);
    expect(out).toHaveLength(1);
    expect(out[0].slotStarts).toEqual([]);
  });

  it("dedupes when the same person matches under both ID schemes", () => {
    // User starred the same person twice — once with their
    // CommunityProfile_ id, once with the EventPeople_ id. Should appear
    // exactly once in the output, in the position of the first hit.
    insertAttendee({
      personId: "CommunityProfile_42",
      eventPeopleId: "EventPeople_42",
      firstName: "Dup",
      lastName: "Person",
    });
    insertAttendee({
      personId: "CommunityProfile_99",
      firstName: "Other",
      lastName: "Person",
    });
    const out = listSavedAttendees(
      "evt",
      ["CommunityProfile_42", "CommunityProfile_99", "EventPeople_42"],
      3600
    );
    expect(out).toHaveLength(2);
    expect(out[0].firstName).toBe("Dup");
    expect(out[1].firstName).toBe("Other");
  });

  it("projects swapcardUrl + jobTitle + company + country + hasPhoto from profile JSON", () => {
    insertAttendee({
      personId: "p1",
      firstName: "Alice",
      lastName: "Smith",
      profile: {
        jobTitle: "Eng",
        company: "Acme",
        country: "UK",
        swapcardUrl: "https://app.swapcard.com/event/x/person/y",
      },
      photoUrl: "https://cdn.example.com/photo.jpg",
    });
    const out = listSavedAttendees("evt", ["p1"], 3600);
    expect(out[0].jobTitle).toBe("Eng");
    expect(out[0].company).toBe("Acme");
    expect(out[0].country).toBe("UK");
    expect(out[0].swapcardUrl).toBe(
      "https://app.swapcard.com/event/x/person/y"
    );
    expect(out[0].hasPhoto).toBe(true);
  });
});
