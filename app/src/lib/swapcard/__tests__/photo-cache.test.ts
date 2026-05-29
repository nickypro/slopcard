import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  cachePathFor,
  defaultCacheDir,
  sanitizePersonId,
} from "@/lib/swapcard/photo-cache";

// Pure helpers + the DB lookup. The route is exercised separately in
// photo-route.test.ts because that file needs to vi.mock("@/lib/db"), which
// would conflict with the real-db tests below.

describe("sanitizePersonId", () => {
  it("passes through Swapcard's normal base64 IDs unchanged", () => {
    // Real EventPeople IDs look like RXZlbnRQZW9wbGVfNDY0MTU0NzI= but the `=`
    // padding gets sanitised to `_`. That's fine — we just need stable, safe
    // filenames; we don't have to round-trip back to the original ID.
    expect(sanitizePersonId("RXZlbnRQZW9wbGVfNDY0MTU0NzI")).toBe(
      "RXZlbnRQZW9wbGVfNDY0MTU0NzI"
    );
    expect(sanitizePersonId("CommunityProfile_12345")).toBe(
      "CommunityProfile_12345"
    );
  });

  it("replaces path separators and traversal sequences", () => {
    expect(sanitizePersonId("../etc/passwd")).toBe("___etc_passwd");
    expect(sanitizePersonId("a/b\\c")).toBe("a_b_c");
  });

  it("replaces shell metacharacters and whitespace", () => {
    expect(sanitizePersonId("a b;c|d&e")).toBe("a_b_c_d_e");
    expect(sanitizePersonId("a\tb\nc")).toBe("a_b_c");
  });

  it("replaces base64 padding/plus/slash chars defensively", () => {
    // The route accepts any string after URL-decoding, including `+/=` which
    // appear in standard (non-url-safe) base64. We don't want any of those in
    // a filename so they get collapsed.
    expect(sanitizePersonId("AB+CD/EF=")).toBe("AB_CD_EF_");
  });

  it("is idempotent on already-safe input", () => {
    const once = sanitizePersonId("weird name!");
    expect(sanitizePersonId(once)).toBe(once);
  });
});

describe("cachePathFor", () => {
  it("composes <dir>/<event>__<person>.bin", () => {
    expect(cachePathFor("/tmp/photos", "eag-london-2026", "PERSON_1")).toBe(
      "/tmp/photos/eag-london-2026__PERSON_1.bin"
    );
  });

  it("sanitises both segments so a hostile eventId can't traverse", () => {
    const p = cachePathFor("/tmp/photos", "../../etc", "id");
    expect(p).toBe("/tmp/photos/______etc__id.bin");
    expect(p).not.toContain("/..");
  });

  it("different personIds map to different paths", () => {
    const a = cachePathFor("/d", "e", "PERSON_A");
    const b = cachePathFor("/d", "e", "PERSON_B");
    expect(a).not.toBe(b);
  });
});

describe("defaultCacheDir", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses DATA_DIR/photos when DATA_DIR is set", () => {
    vi.stubEnv("DATA_DIR", "/var/lib/slopcard");
    expect(defaultCacheDir()).toBe("/var/lib/slopcard/photos");
  });

  it("falls back to /app/data/photos when DATA_DIR is unset", () => {
    vi.stubEnv("DATA_DIR", "");
    expect(defaultCacheDir()).toBe("/app/data/photos");
  });
});

// ── getSwapcardAttendeePhotoUrl ──────────────────────────────────────────────
//
// db.ts opens a real sqlite handle at import time, so each test gets its own
// DATA_DIR (and therefore its own .db file) via vi.resetModules() + a fresh
// dynamic import. The lookup is just two SQL paths, so we exercise both ID
// schemes plus the null/miss cases.

describe("getSwapcardAttendeePhotoUrl", () => {
  let tmpDir: string;
  let db: typeof import("@/lib/db");

  beforeEach(async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const pathMod = await import("node:path");
    tmpDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "slopcard-photo-cache-"));
    vi.stubEnv("DATA_DIR", tmpDir);
    vi.resetModules();
    db = await import("@/lib/db");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    const fs = await import("node:fs");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertAttendee(args: {
    eventId: string;
    personId: string | null;
    eventPeopleId: string | null;
    photoUrl: string | null;
  }) {
    const sqlite = db.default;
    sqlite
      .prepare(
        `INSERT INTO swapcard_attendees
          (event_id, person_id, event_people_id, first_name, last_name,
           profile_json, embedding, photo_url, sheet_signature, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        args.eventId,
        args.personId,
        args.eventPeopleId,
        "Alice",
        "Smith",
        "{}",
        Buffer.alloc(0),
        args.photoUrl,
        "sig-1",
        Date.now()
      );
  }

  it("returns the photo when looked up by person_id", () => {
    insertAttendee({
      eventId: "eag-london-2026",
      personId: "CommunityProfile_1",
      eventPeopleId: "EventPeople_1",
      photoUrl: "https://cdn.example/a.jpg",
    });
    expect(
      db.getSwapcardAttendeePhotoUrl("eag-london-2026", "CommunityProfile_1")
    ).toBe("https://cdn.example/a.jpg");
  });

  it("returns the photo when looked up by event_people_id", () => {
    insertAttendee({
      eventId: "eag-london-2026",
      personId: "CommunityProfile_2",
      eventPeopleId: "EventPeople_2",
      photoUrl: "https://cdn.example/b.jpg",
    });
    expect(
      db.getSwapcardAttendeePhotoUrl("eag-london-2026", "EventPeople_2")
    ).toBe("https://cdn.example/b.jpg");
  });

  it("returns null when the personId isn't in the DB", () => {
    expect(
      db.getSwapcardAttendeePhotoUrl("eag-london-2026", "no_such_id")
    ).toBeNull();
  });

  it("returns null when the row has no photo_url", () => {
    insertAttendee({
      eventId: "eag-london-2026",
      personId: "CommunityProfile_3",
      eventPeopleId: null,
      photoUrl: null,
    });
    expect(
      db.getSwapcardAttendeePhotoUrl("eag-london-2026", "CommunityProfile_3")
    ).toBeNull();
  });

  it("scopes lookups to the right event_id", () => {
    insertAttendee({
      eventId: "eag-london-2026",
      personId: "CommunityProfile_4",
      eventPeopleId: null,
      photoUrl: "https://cdn.example/c.jpg",
    });
    expect(
      db.getSwapcardAttendeePhotoUrl("other-event", "CommunityProfile_4")
    ).toBeNull();
  });
});
