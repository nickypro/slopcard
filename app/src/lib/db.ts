import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "fs";
import path from "path";
import crypto from "crypto";
import type { ScrapedSession } from "@/lib/swapcard/scrape-agenda-events";

const DB_DIR = process.env.DATA_DIR || "/app/data";
if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, "slopcard.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS cards (
    handle         TEXT PRIMARY KEY,
    display_name   TEXT NOT NULL DEFAULT '',
    description    TEXT NOT NULL DEFAULT '',
    avatar_url     TEXT NOT NULL DEFAULT '',
    swapcard_url   TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved')),
    preview_token  TEXT NOT NULL UNIQUE,
    submitter_ip   TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    approved_at    INTEGER
  );
  CREATE INDEX IF NOT EXISTS cards_status ON cards(status);
`);

// Migration: add accent_color columns if missing.
const cols = db.prepare("PRAGMA table_info(cards)").all() as { name: string }[];
const hasCol = (n: string) => cols.some((c) => c.name === n);
if (!hasCol("accent_color")) {
  db.exec("ALTER TABLE cards ADD COLUMN accent_color TEXT");
}
if (!hasCol("accent_color_dark")) {
  db.exec("ALTER TABLE cards ADD COLUMN accent_color_dark TEXT");
}
if (!hasCol("verified_twitter_id")) {
  db.exec("ALTER TABLE cards ADD COLUMN verified_twitter_id TEXT");
}
if (!hasCol("verified_at")) {
  db.exec("ALTER TABLE cards ADD COLUMN verified_at INTEGER");
}
if (!hasCol("listed")) {
  db.exec("ALTER TABLE cards ADD COLUMN listed INTEGER NOT NULL DEFAULT 1");
}
// Swapcard verification: the person_id is the canonical attendee ID from the
// Swapcard URL (base64 of `EventPeople_<num>`). Marked UNIQUE so a Swapcard
// profile can only be claimed by one slopcard user. NULL columns are excluded
// from uniqueness in SQLite, so unlinked cards don't collide.
if (!hasCol("swapcard_person_id")) {
  db.exec("ALTER TABLE cards ADD COLUMN swapcard_person_id TEXT");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS cards_swapcard_person_id ON cards(swapcard_person_id) WHERE swapcard_person_id IS NOT NULL"
  );
}
if (!hasCol("swapcard_event_id")) {
  db.exec("ALTER TABLE cards ADD COLUMN swapcard_event_id TEXT");
}
if (!hasCol("swapcard_verified_at")) {
  db.exec("ALTER TABLE cards ADD COLUMN swapcard_verified_at INTEGER");
}

// Append-only audit log. Never updated, only inserted. Captures every
// mutation to a card with full before/after snapshots so deleted data isn't
// lost and changes are auditable. Querying for "current state" stays on the
// `cards` table — this is only read for history.
db.exec(`
  CREATE TABLE IF NOT EXISTS card_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    handle       TEXT NOT NULL,
    action       TEXT NOT NULL,   -- create | create_verified | update | approve | delete | swapcard_verified | swapcard_unverified
    actor        TEXT NOT NULL,   -- anon:<ip> | verified:<twitter_id> | admin
    before_json  TEXT,            -- snapshot of card BEFORE the action (NULL for creates)
    after_json   TEXT             -- snapshot of card AFTER the action (NULL for deletes)
  );
  CREATE INDEX IF NOT EXISTS card_events_handle ON card_events(handle);
  CREATE INDEX IF NOT EXISTS card_events_ts ON card_events(ts);
`);

// Swapcard attendee cache. One row per attendee per event. `embedding` is a
// raw Float32 buffer matching EMBED_DIM (384) — kept inline so retrieval can
// load everything in a single SELECT. `sheet_signature` tags every row with
// the snapshot version they came from, so we can detect staleness without
// diffing the sheet.
//
// Two Swapcard ID schemes coexist for the same person:
//   person_id        — CommunityProfile_<n>; what the sheet stores
//   event_people_id  — EventPeople_<n>; what the browser URL bar shows
// Both are populated where we know them (sheet ingest sets person_id; the
// scrape job calls Swapcard's GraphQL with a logged-in token to fetch
// EventPeople records and matches them back to sheet rows by name).
db.exec(`
  CREATE TABLE IF NOT EXISTS swapcard_attendees (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id         TEXT NOT NULL,
    person_id        TEXT,
    event_people_id  TEXT,
    first_name       TEXT NOT NULL DEFAULT '',
    last_name        TEXT NOT NULL DEFAULT '',
    profile_json     TEXT NOT NULL,
    embedding        BLOB NOT NULL,
    photo_url        TEXT,
    sheet_signature  TEXT NOT NULL,
    fetched_at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS swapcard_attendees_event ON swapcard_attendees(event_id);
  CREATE UNIQUE INDEX IF NOT EXISTS swapcard_attendees_person ON swapcard_attendees(event_id, person_id) WHERE person_id IS NOT NULL;
`);

// Migrations: add columns to existing swapcard_attendees rows. Must happen
// BEFORE any partial index referencing those columns is created, because
// CREATE TABLE IF NOT EXISTS is a no-op when an older table is already there.
const swapcardCols = db
  .prepare("PRAGMA table_info(swapcard_attendees)")
  .all() as { name: string }[];
if (!swapcardCols.some((c) => c.name === "event_people_id")) {
  db.exec("ALTER TABLE swapcard_attendees ADD COLUMN event_people_id TEXT");
}
if (!swapcardCols.some((c) => c.name === "photo_url")) {
  db.exec("ALTER TABLE swapcard_attendees ADD COLUMN photo_url TEXT");
}
db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS swapcard_attendees_event_people ON swapcard_attendees(event_id, event_people_id) WHERE event_people_id IS NOT NULL"
);

// Per-attendee available meeting-slot cache. One row per (event_id,
// event_people_id), upserted by the admin refresh endpoint that calls
// fetchMeetSlotsBatch. The slot JSON is a serialised MeetSlot[] from
// scrape-agenda.ts — keeping it inline lets /discover annotate recs with a
// "N free slots" badge in a single SELECT. fetched_at gates a TTL so stale
// rows don't surface bogus counts after the conference moves on.
db.exec(`
  CREATE TABLE IF NOT EXISTS attendee_slots (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id         TEXT NOT NULL,
    event_people_id  TEXT NOT NULL,
    slots_json       TEXT NOT NULL,
    fetched_at       INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS attendee_slots_lookup ON attendee_slots(event_id, event_people_id);
`);

// General event-agenda cache. One row per Swapcard session (talk, plenary,
// workshop, ...). The full ScrapedSession is duplicated into `payload_json`
// so future schema additions (e.g. exposing maxSeats in the UI) don't require
// a re-scrape — we just widen the column list we read from JSON. The
// dedicated columns are projections we sort/filter on at SQL level.
db.exec(`
  CREATE TABLE IF NOT EXISTS event_sessions (
    event_id          TEXT NOT NULL,
    planning_id       TEXT PRIMARY KEY,
    title             TEXT NOT NULL DEFAULT '',
    begins_at         TEXT NOT NULL,
    ends_at           TEXT NOT NULL,
    place             TEXT NOT NULL DEFAULT '',
    format            TEXT NOT NULL DEFAULT '',
    description_html  TEXT NOT NULL DEFAULT '',
    payload_json      TEXT NOT NULL,
    fetched_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS event_sessions_event ON event_sessions(event_id);
  CREATE INDEX IF NOT EXISTS event_sessions_time ON event_sessions(begins_at);
`);

// Swapcard link approval queue. When SWAPCARD_REQUIRE_APPROVAL=1, /api/swapcard/link
// inserts a pending row here instead of calling linkSwapcardToCard directly, and
// the admin manually approves via the SMS-delivered token URL. The partial
// unique index on (handle, person_id) WHERE state='pending' is what makes the
// claim flow idempotent — duplicate POSTs collapse onto the same request id and
// don't re-trigger an SMS.
db.exec(`
  CREATE TABLE IF NOT EXISTS swapcard_link_requests (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    handle              TEXT NOT NULL,
    person_id           TEXT NOT NULL,
    event_id            TEXT NOT NULL,
    linked_name         TEXT NOT NULL DEFAULT '',
    state               TEXT NOT NULL CHECK (state IN ('pending','approved','rejected')),
    approve_token       TEXT NOT NULL UNIQUE,
    requested_at        INTEGER NOT NULL,
    decided_at          INTEGER,
    decided_by          TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS swapcard_link_requests_pending ON swapcard_link_requests(handle, person_id) WHERE state = 'pending';
`);

// Discover-run cache. One stored run per (handle, event_id, sheet_signature).
// Refreshing recommendations creates a new sheet-signature record; older
// records are kept for history (cheap, append-only). Reads always fetch the
// most-recent run for the current sheet_signature.
db.exec(`
  CREATE TABLE IF NOT EXISTS swapcard_discover_runs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    handle           TEXT NOT NULL,
    event_id         TEXT NOT NULL,
    sheet_signature  TEXT NOT NULL,
    payload_json     TEXT NOT NULL,
    created_at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS swapcard_discover_runs_lookup ON swapcard_discover_runs(handle, event_id, sheet_signature, created_at DESC);
`);

// Seed cutesuscat once
const seedExists = db
  .prepare("SELECT 1 FROM cards WHERE handle = ?")
  .get("cutesuscat");
if (!seedExists) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO cards (handle, swapcard_url, status, preview_token, created_at, updated_at, approved_at)
     VALUES (?, ?, 'approved', ?, ?, ?, ?)`
  ).run(
    "cutesuscat",
    "https://app.swapcard.com/event/eag-london/person/RXZlbnRQZW9wbGVfNDY0MTU0NzI=",
    crypto.randomBytes(16).toString("hex"),
    now,
    now,
    now
  );
}

export type CardStatus = "pending" | "approved";

export interface Card {
  handle: string;
  displayName: string;
  description: string;
  avatarUrl: string;
  swapcardUrl: string;
  status: CardStatus;
  previewToken: string;
  submitterIp: string | null;
  createdAt: number;
  updatedAt: number;
  approvedAt: number | null;
  accentColor: string | null;
  accentColorDark: string | null;
  verifiedTwitterId: string | null;
  verifiedAt: number | null;
  listed: boolean;
  swapcardPersonId: string | null;
  swapcardEventId: string | null;
  swapcardVerifiedAt: number | null;
}

interface CardRow {
  handle: string;
  display_name: string;
  description: string;
  avatar_url: string;
  swapcard_url: string;
  status: CardStatus;
  preview_token: string;
  submitter_ip: string | null;
  created_at: number;
  updated_at: number;
  approved_at: number | null;
  accent_color: string | null;
  accent_color_dark: string | null;
  verified_twitter_id: string | null;
  verified_at: number | null;
  listed: number;
  swapcard_person_id: string | null;
  swapcard_event_id: string | null;
  swapcard_verified_at: number | null;
}

const toCard = (r: CardRow): Card => ({
  handle: r.handle,
  displayName: r.display_name,
  description: r.description,
  avatarUrl: r.avatar_url,
  swapcardUrl: r.swapcard_url,
  status: r.status,
  previewToken: r.preview_token,
  submitterIp: r.submitter_ip,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  approvedAt: r.approved_at,
  accentColor: r.accent_color,
  accentColorDark: r.accent_color_dark,
  verifiedTwitterId: r.verified_twitter_id,
  verifiedAt: r.verified_at,
  listed: r.listed !== 0,
  swapcardPersonId: r.swapcard_person_id,
  swapcardEventId: r.swapcard_event_id,
  swapcardVerifiedAt: r.swapcard_verified_at,
});

export type CardEventAction =
  | "create"
  | "create_verified"
  | "update"
  | "approve"
  | "delete"
  | "swapcard_verified"
  | "swapcard_unverified";

export interface CardEvent {
  id: number;
  ts: number;
  handle: string;
  action: CardEventAction;
  actor: string;
  before: Card | null;
  after: Card | null;
}

function logEvent(
  handle: string,
  action: CardEventAction,
  actor: string,
  before: Card | null,
  after: Card | null
): void {
  db.prepare(
    `INSERT INTO card_events (ts, handle, action, actor, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    Date.now(),
    handle.toLowerCase(),
    action,
    actor,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null
  );
}

export function listEventsForHandle(handle: string): CardEvent[] {
  const rows = db
    .prepare(
      "SELECT id, ts, handle, action, actor, before_json, after_json FROM card_events WHERE handle = ? ORDER BY id ASC"
    )
    .all(handle.toLowerCase()) as {
    id: number;
    ts: number;
    handle: string;
    action: CardEventAction;
    actor: string;
    before_json: string | null;
    after_json: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    handle: r.handle,
    action: r.action,
    actor: r.actor,
    before: r.before_json ? (JSON.parse(r.before_json) as Card) : null,
    after: r.after_json ? (JSON.parse(r.after_json) as Card) : null,
  }));
}

export function getCard(handle: string): Card | null {
  const row = db
    .prepare("SELECT * FROM cards WHERE handle = ?")
    .get(handle.toLowerCase()) as CardRow | undefined;
  return row ? toCard(row) : null;
}

export function getCardByToken(token: string): Card | null {
  const row = db
    .prepare("SELECT * FROM cards WHERE preview_token = ?")
    .get(token) as CardRow | undefined;
  return row ? toCard(row) : null;
}

export function listCardsByStatus(status: CardStatus): Card[] {
  const rows = db
    .prepare("SELECT * FROM cards WHERE status = ? ORDER BY created_at DESC")
    .all(status) as CardRow[];
  return rows.map(toCard);
}

export function listListedApprovedCards(): Card[] {
  const rows = db
    .prepare(
      "SELECT * FROM cards WHERE status = 'approved' AND listed = 1 ORDER BY COALESCE(approved_at, created_at) DESC"
    )
    .all() as CardRow[];
  return rows.map(toCard);
}

export function setListed(handle: string, listed: boolean): void {
  db.prepare("UPDATE cards SET listed = ? WHERE handle = ?").run(
    listed ? 1 : 0,
    handle.toLowerCase()
  );
}

export interface SubmitInput {
  handle: string;
  displayName: string;
  description: string;
  avatarUrl: string;
  swapcardUrl: string;
  submitterIp: string | null;
  listed: boolean;
}

export function createPendingCard(input: SubmitInput, actor: string): Card {
  const now = Date.now();
  const handle = input.handle.toLowerCase();
  const token = crypto.randomBytes(16).toString("hex");
  db.prepare(
    `INSERT INTO cards (handle, display_name, description, avatar_url, swapcard_url, status, preview_token, submitter_ip, listed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
  ).run(
    handle,
    input.displayName,
    input.description,
    input.avatarUrl,
    input.swapcardUrl,
    token,
    input.submitterIp,
    input.listed ? 1 : 0,
    now,
    now
  );
  const card = getCard(handle)!;
  logEvent(handle, "create", actor, null, card);
  return card;
}

export type CardEdits = Partial<
  Pick<Card, "displayName" | "description" | "avatarUrl" | "swapcardUrl">
>;

export function updateCardFields(
  handle: string,
  edits: CardEdits,
  actor: string
): Card | null {
  const existing = getCard(handle);
  if (!existing) return null;
  const now = Date.now();
  db.prepare(
    `UPDATE cards
     SET display_name = ?, description = ?, avatar_url = ?, swapcard_url = ?, updated_at = ?
     WHERE handle = ?`
  ).run(
    edits.displayName ?? existing.displayName,
    edits.description ?? existing.description,
    edits.avatarUrl ?? existing.avatarUrl,
    edits.swapcardUrl ?? existing.swapcardUrl,
    now,
    handle.toLowerCase()
  );
  const after = getCard(handle);
  if (after) logEvent(handle, "update", actor, existing, after);
  return after;
}

export function approveCard(
  handle: string,
  actor: string,
  edits?: CardEdits
): Card | null {
  const existing = getCard(handle);
  if (!existing) return null;
  const now = Date.now();
  db.prepare(
    `UPDATE cards
     SET display_name = ?, description = ?, avatar_url = ?, swapcard_url = ?, status = 'approved', approved_at = ?, updated_at = ?
     WHERE handle = ?`
  ).run(
    edits?.displayName ?? existing.displayName,
    edits?.description ?? existing.description,
    edits?.avatarUrl ?? existing.avatarUrl,
    edits?.swapcardUrl ?? existing.swapcardUrl,
    now,
    now,
    handle.toLowerCase()
  );
  const after = getCard(handle);
  if (after) logEvent(handle, "approve", actor, existing, after);
  return after;
}

export function deleteCard(handle: string, actor: string): boolean {
  const existing = getCard(handle);
  if (!existing) return false;
  const res = db
    .prepare("DELETE FROM cards WHERE handle = ?")
    .run(handle.toLowerCase());
  if (res.changes > 0) {
    logEvent(handle, "delete", actor, existing, null);
    return true;
  }
  return false;
}

export function setAccentColor(
  handle: string,
  hex: string | null,
  darkHex: string | null
): void {
  db.prepare(
    "UPDATE cards SET accent_color = ?, accent_color_dark = ? WHERE handle = ?"
  ).run(hex, darkHex, handle.toLowerCase());
}

export function setVerified(handle: string, twitterId: string): void {
  const now = Date.now();
  db.prepare(
    "UPDATE cards SET verified_twitter_id = ?, verified_at = ? WHERE handle = ?"
  ).run(twitterId, now, handle.toLowerCase());
}

export function createVerifiedApprovedCard(
  input: SubmitInput & { twitterId: string },
  actor: string
): Card {
  const now = Date.now();
  const handle = input.handle.toLowerCase();
  const token = crypto.randomBytes(16).toString("hex");
  db.prepare(
    `INSERT INTO cards (handle, display_name, description, avatar_url, swapcard_url,
                        status, preview_token, submitter_ip,
                        verified_twitter_id, verified_at,
                        listed, created_at, updated_at, approved_at)
     VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    handle,
    input.displayName,
    input.description,
    input.avatarUrl,
    input.swapcardUrl,
    token,
    input.submitterIp,
    input.twitterId,
    now,
    input.listed ? 1 : 0,
    now,
    now,
    now
  );
  const card = getCard(handle)!;
  logEvent(handle, "create_verified", actor, null, card);
  return card;
}

// ── Swapcard verification on cards ───────────────────────────────────────────

export function getCardBySwapcardPersonId(personId: string): Card | null {
  const row = db
    .prepare("SELECT * FROM cards WHERE swapcard_person_id = ?")
    .get(personId) as CardRow | undefined;
  return row ? toCard(row) : null;
}

export type LinkSwapcardResult =
  | { ok: true; card: Card }
  | { ok: false; reason: "not_found" | "already_linked_other" | "not_in_attendees" };

/**
 * Link an authenticated user's card to a Swapcard attendee. Idempotent for the
 * same (handle, personId) pair. Fails with `already_linked_other` if another
 * slopcard card has already claimed that personId. The caller is expected to
 * have already verified the personId exists in the attendee cache via
 * `getSwapcardAttendeeByPersonId`.
 */
export function linkSwapcardToCard(
  handle: string,
  eventId: string,
  personId: string,
  actor: string
): LinkSwapcardResult {
  const before = getCard(handle);
  if (!before) return { ok: false, reason: "not_found" };
  // Idempotent: re-linking the same person is a no-op (return success).
  if (before.swapcardPersonId === personId) return { ok: true, card: before };

  const claimed = getCardBySwapcardPersonId(personId);
  if (claimed && claimed.handle !== handle) {
    return { ok: false, reason: "already_linked_other" };
  }
  const now = Date.now();
  db.prepare(
    "UPDATE cards SET swapcard_person_id = ?, swapcard_event_id = ?, swapcard_verified_at = ? WHERE handle = ?"
  ).run(personId, eventId, now, handle.toLowerCase());
  const after = getCard(handle);
  if (after) logEvent(handle, "swapcard_verified", actor, before, after);
  return after ? { ok: true, card: after } : { ok: false, reason: "not_found" };
}

export function unlinkSwapcardFromCard(handle: string, actor: string): Card | null {
  const before = getCard(handle);
  if (!before || !before.swapcardPersonId) return before;
  db.prepare(
    "UPDATE cards SET swapcard_person_id = NULL, swapcard_event_id = NULL, swapcard_verified_at = NULL WHERE handle = ?"
  ).run(handle.toLowerCase());
  const after = getCard(handle);
  if (after) logEvent(handle, "swapcard_unverified", actor, before, after);
  return after;
}

// ── Swapcard attendee cache ──────────────────────────────────────────────────

export interface SwapcardAttendeeRow {
  eventId: string;
  personId: string | null;
  eventPeopleId: string | null;
  firstName: string;
  lastName: string;
  profileJson: string;
  embedding: Buffer;
  photoUrl: string | null;
  sheetSignature: string;
  fetchedAt: number;
}

export function getSheetSignature(eventId: string): string | null {
  const row = db
    .prepare(
      "SELECT sheet_signature FROM swapcard_attendees WHERE event_id = ? LIMIT 1"
    )
    .get(eventId) as { sheet_signature: string } | undefined;
  return row?.sheet_signature ?? null;
}

interface SwapcardAttendeeDbRow {
  event_id: string;
  person_id: string | null;
  event_people_id: string | null;
  first_name: string;
  last_name: string;
  profile_json: string;
  embedding: Buffer;
  photo_url: string | null;
  sheet_signature: string;
  fetched_at: number;
}

const SWAPCARD_ATTENDEE_COLS =
  "event_id, person_id, event_people_id, first_name, last_name, profile_json, embedding, photo_url, sheet_signature, fetched_at";

const toSwapcardAttendee = (row: SwapcardAttendeeDbRow): SwapcardAttendeeRow => ({
  eventId: row.event_id,
  personId: row.person_id,
  eventPeopleId: row.event_people_id,
  firstName: row.first_name,
  lastName: row.last_name,
  profileJson: row.profile_json,
  embedding: row.embedding,
  photoUrl: row.photo_url,
  sheetSignature: row.sheet_signature,
  fetchedAt: row.fetched_at,
});

export function getSwapcardAttendeeByPersonId(
  eventId: string,
  personId: string
): SwapcardAttendeeRow | null {
  const row = db
    .prepare(
      `SELECT ${SWAPCARD_ATTENDEE_COLS} FROM swapcard_attendees WHERE event_id = ? AND person_id = ?`
    )
    .get(eventId, personId) as SwapcardAttendeeDbRow | undefined;
  return row ? toSwapcardAttendee(row) : null;
}

// Look up by EITHER ID scheme — used by the link route so a pasted URL
// resolves whether it's CommunityProfile_<n> (from the sheet form) or
// EventPeople_<n> (from the browser app URL bar).
export function getSwapcardAttendeeByAnyId(
  eventId: string,
  id: string
): SwapcardAttendeeRow | null {
  const row = db
    .prepare(
      `SELECT ${SWAPCARD_ATTENDEE_COLS} FROM swapcard_attendees WHERE event_id = ? AND (person_id = ? OR event_people_id = ?)`
    )
    .get(eventId, id, id) as SwapcardAttendeeDbRow | undefined;
  return row ? toSwapcardAttendee(row) : null;
}

// Just the photo_url, looked up by either ID scheme. Used by the photo-cache
// route to resolve a personId URL param to the upstream Swapcard CDN URL.
// Returns null when there's no matching attendee or the row has no photo.
export function getSwapcardAttendeePhotoUrl(
  eventId: string,
  anyId: string
): string | null {
  const row = db
    .prepare(
      "SELECT photo_url FROM swapcard_attendees WHERE event_id = ? AND (person_id = ? OR event_people_id = ?)"
    )
    .get(eventId, anyId, anyId) as { photo_url: string | null } | undefined;
  return row?.photo_url ?? null;
}

// Set the EventPeople ID + photoUrl on an existing sheet row whose
// CommunityProfile ID matched a scraped EventPeople record by name.
export function setSwapcardAttendeeEventPeopleAndPhoto(
  eventId: string,
  personId: string,
  eventPeopleId: string,
  photoUrl: string | null
): void {
  db.prepare(
    "UPDATE swapcard_attendees SET event_people_id = ?, photo_url = COALESCE(?, photo_url) WHERE event_id = ? AND person_id = ?"
  ).run(eventPeopleId, photoUrl, eventId, personId);
}

// Row-id-keyed variant for sheet rows that have NULL person_id (attendees who
// filled the sheet but didn't include their Swapcard URL → no CommunityProfile
// id to key off). The matcher name-matches them and uses this to attach the
// event_people_id + photo so they stop appearing as "duplicates with no link"
// next to the EventPeople-only stub for the same person.
export function setSwapcardAttendeeEventPeopleAndPhotoByRowId(
  rowId: number,
  eventPeopleId: string,
  photoUrl: string | null
): void {
  db.prepare(
    "UPDATE swapcard_attendees SET event_people_id = ?, photo_url = COALESCE(?, photo_url) WHERE id = ?"
  ).run(eventPeopleId, photoUrl, rowId);
}

// Delete a row by id. Used by match-event-people to clean up the redundant
// stub when the same attendee turns out to have a sheet row already (matched
// by name). Safe — the orphan row had no person_id and at most a zero
// embedding, so nothing else in the system references it.
export function deleteSwapcardAttendeeByRowId(rowId: number): void {
  db.prepare("DELETE FROM swapcard_attendees WHERE id = ?").run(rowId);
}

// Insert a stub attendee row for an EventPeople record that has no sheet
// match — covers attendees who opted out of the public EAG sheet. They can
// still link a card via URL paste (so /discover gets unlocked), but the
// stub has minimal profile content, so they won't surface in others'
// recommendations (zero embedding → ranks dead last on any cosine query).
//
// Explicit query-then-write instead of ON CONFLICT because SQLite won't
// resolve ON CONFLICT against a partial unique index here.
export function upsertSwapcardAttendeeStub(args: {
  eventId: string;
  eventPeopleId: string;
  firstName: string;
  lastName: string;
  profileJson: string;
  embedding: Buffer;
  photoUrl: string | null;
  sheetSignature: string;
}): void {
  const now = Date.now();
  const existing = db
    .prepare(
      "SELECT id FROM swapcard_attendees WHERE event_id = ? AND event_people_id = ?"
    )
    .get(args.eventId, args.eventPeopleId) as { id: number } | undefined;
  if (existing) {
    db.prepare(
      "UPDATE swapcard_attendees SET first_name = ?, last_name = ?, photo_url = COALESCE(?, photo_url), fetched_at = ? WHERE id = ?"
    ).run(args.firstName, args.lastName, args.photoUrl, now, existing.id);
    return;
  }
  db.prepare(
    `INSERT INTO swapcard_attendees
       (event_id, person_id, event_people_id, first_name, last_name, profile_json, embedding, photo_url, sheet_signature, fetched_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    args.eventId,
    args.eventPeopleId,
    args.firstName,
    args.lastName,
    args.profileJson,
    args.embedding,
    args.photoUrl,
    args.sheetSignature,
    now
  );
}

// Slim row shape for the participants search page. We don't ship the full
// profile JSON or embedding back to the page — names + the bits the row card
// renders (role, company, country) is all the UI needs, and `hasPhoto`
// telegraphs whether the avatar slot will resolve via /api/swapcard/photo.
export interface SwapcardAttendeeSearchResult {
  personId: string | null;
  eventPeopleId: string | null;
  firstName: string;
  lastName: string;
  jobTitle: string;
  company: string;
  country: string;
  // Pulled out of profile_json so the page can render an outbound link. The
  // page re-runs parseSwapcardUrl on this string before trusting it — sheet
  // contents are user-supplied, so we never put a raw href in the DOM here.
  swapcardUrl: string;
  hasPhoto: boolean;
}

// Build the ORDER BY expression used by both the count and the page query so
// they agree about what "page 2" means. The prefix-rank trick (LIKE on the
// concatenated name, lowercased) hoists rows whose name STARTS with the
// query above plain substring hits — that's what makes a search for "ali"
// surface "Alice Smith" before "Calista Alimov". Empty query collapses both
// rank columns to a constant so the result is plain alphabetical.
function searchOrderByClause(): string {
  return `
    ORDER BY name_prefix_rank ASC,
             LOWER(first_name) ASC,
             LOWER(last_name) ASC,
             id ASC
  `;
}

// LIKE-based search across the cached attendee profile JSON. We tokenise the
// query on whitespace and require every token to match SOMEWHERE — within a
// single token, columns are OR'd; across tokens they're AND'd. The columns
// we scan are denormalised projections of the same profile JSON, so this is
// the cheapest possible way to support "name OR jobTitle OR expertise"
// without a separate FTS table.
//
// On the EAG 2026 dataset (~2278 rows) this runs in well under 5ms per
// query without any index — sqlite scans the table linearly but the rows
// are small and we cap at LIMIT. If the dataset grows past ~20k rows the
// right move is an FTS5 virtual table rebuilt on ingest, not adding more
// indices to this table.
export function searchSwapcardAttendees(
  eventId: string,
  query: string,
  limit = 50,
  offset = 0,
  causeArea?: string
): { results: SwapcardAttendeeSearchResult[]; total: number } {
  // Optional cause-area filter from the /people dropdown. Matches against the
  // ingested `profile_json.interests[]` array (case-insensitive). Empty/blank
  // value collapses to "no filter" so callers don't need to guard themselves.
  const causeAreaTrimmed = causeArea?.trim() ?? "";
  const causeAreaClause = causeAreaTrimmed
    ? ` AND EXISTS (
          SELECT 1 FROM json_each(json_extract(profile_json, '$.interests'))
          WHERE LOWER(value) = LOWER(?)
        )`
    : "";
  const causeAreaParam: string[] = causeAreaTrimmed ? [causeAreaTrimmed] : [];
  // Defense-in-depth (iter 19 pen-test): cap raw query length so a hostile
  // client can't ship a megabyte string that explodes the LIKE patterns into
  // table-scans of unbounded size.
  if (query.length > 100) query = query.slice(0, 100);
  const trimmed = query.trim();
  // Empty query: alphabetical browse mode. Skip the prefix-rank
  // computation entirely so the query stays a plain SELECT.
  if (trimmed.length === 0) {
    const totalRow = db
      .prepare(
        `SELECT COUNT(*) AS c FROM swapcard_attendees WHERE event_id = ?${causeAreaClause}`
      )
      .get(eventId, ...causeAreaParam) as { c: number };
    const rows = db
      .prepare(
        `SELECT person_id, event_people_id, first_name, last_name, profile_json, photo_url
         FROM swapcard_attendees
         WHERE event_id = ?${causeAreaClause}
         ORDER BY LOWER(first_name) ASC, LOWER(last_name) ASC, id ASC
         LIMIT ? OFFSET ?`
      )
      .all(eventId, ...causeAreaParam, limit, offset) as {
      person_id: string | null;
      event_people_id: string | null;
      first_name: string;
      last_name: string;
      profile_json: string;
      photo_url: string | null;
    }[];
    return {
      results: rows.map(projectSearchRow),
      total: totalRow.c,
    };
  }

  // Tokenise on whitespace. We expect short queries (1-4 tokens); long ones
  // still work but each adds a new AND clause that runs the same column
  // scan, so they slow proportionally. Lowercasing once here lets every
  // LIKE on a LOWER(col) skip an extra function call.
  //
  // Defense-in-depth (iter 19 pen-test):
  // - strip `%`/`_` from each token so the user can't force every row to
  //   match (`%` is the SQL LIKE wildcard; an attacker-supplied `%` would
  //   defeat the substring boundary we wrap below).
  // - cap token count at 8 so a 100-token query can't multiply our AND
  //   clauses into an O(rows × tokens × 8 cols) hot loop.
  let tokens = trimmed
    .toLowerCase()
    .split(/\s+/)
    .map((tok) => tok.replace(/[%_]/g, ""))
    .filter(Boolean);
  tokens = tokens.slice(0, 8);
  // After stripping, the query might have collapsed to nothing — fall back
  // to the empty-query branch behaviour by re-running the alphabetical path.
  if (tokens.length === 0) {
    const totalRow = db
      .prepare(
        `SELECT COUNT(*) AS c FROM swapcard_attendees WHERE event_id = ?${causeAreaClause}`
      )
      .get(eventId, ...causeAreaParam) as { c: number };
    const rows = db
      .prepare(
        `SELECT person_id, event_people_id, first_name, last_name, profile_json, photo_url
         FROM swapcard_attendees
         WHERE event_id = ?${causeAreaClause}
         ORDER BY LOWER(first_name) ASC, LOWER(last_name) ASC, id ASC
         LIMIT ? OFFSET ?`
      )
      .all(eventId, ...causeAreaParam, limit, offset) as {
      person_id: string | null;
      event_people_id: string | null;
      first_name: string;
      last_name: string;
      profile_json: string;
      photo_url: string | null;
    }[];
    return {
      results: rows.map(projectSearchRow),
      total: totalRow.c,
    };
  }
  const prefixPattern = `${tokens[0]}%`;

  // Per-token WHERE fragment: OR across every column we know to scan.
  // expertise/interests are JSON arrays so we need json_each to fan out.
  // We re-use the same `?` token for every position via the params array
  // below — better-sqlite3 binds positionally, so the order must match.
  const perTokenClause = `(
    LOWER(first_name) LIKE ?
    OR LOWER(last_name) LIKE ?
    OR LOWER(first_name || ' ' || last_name) LIKE ?
    OR LOWER(COALESCE(json_extract(profile_json, '$.jobTitle'), '')) LIKE ?
    OR LOWER(COALESCE(json_extract(profile_json, '$.company'), '')) LIKE ?
    OR LOWER(COALESCE(json_extract(profile_json, '$.biography'), '')) LIKE ?
    OR EXISTS (
      SELECT 1 FROM json_each(json_extract(profile_json, '$.expertise'))
      WHERE LOWER(value) LIKE ?
    )
    OR EXISTS (
      SELECT 1 FROM json_each(json_extract(profile_json, '$.interests'))
      WHERE LOWER(value) LIKE ?
    )
  )`;
  const COLS_PER_TOKEN = 8;

  const whereClauses: string[] = ["event_id = ?"];
  const params: (string | number)[] = [eventId];
  for (const tok of tokens) {
    whereClauses.push(perTokenClause);
    const pat = `%${tok}%`;
    for (let i = 0; i < COLS_PER_TOKEN; i++) params.push(pat);
  }
  // Cause-area filter appends after token clauses so the same WHERE is shared
  // by the count query and the page query (params stay positional).
  if (causeAreaTrimmed) {
    whereClauses.push(`EXISTS (
      SELECT 1 FROM json_each(json_extract(profile_json, '$.interests'))
      WHERE LOWER(value) = LOWER(?)
    )`);
    params.push(causeAreaTrimmed);
  }
  const whereSql = whereClauses.join(" AND ");

  // Count first so the caller can render "showing 50 of N" without paging
  // through the rest. Count uses the same WHERE as the page query so
  // they stay in sync.
  const totalRow = db
    .prepare(
      `SELECT COUNT(*) AS c FROM swapcard_attendees WHERE ${whereSql}`
    )
    .get(...params) as { c: number };

  // Prefix-rank column: 0 when the full name starts with the first token,
  // 1 otherwise. Plain alphabetical inside each bucket. Putting the rank in
  // SELECT (not WHERE) costs one extra comparison per row but is what
  // makes "ali" → "Alice Smith" before "Calista Alimov".
  // Param order matters: the `?` in the SELECT CASE is bound FIRST, then
  // the WHERE-clause params, then LIMIT/OFFSET. Get this wrong and the
  // prefix pattern ends up in the event_id slot and you get zero hits.
  const pageParams: (string | number)[] = [
    prefixPattern,
    ...params,
    limit,
    offset,
  ];
  const rows = db
    .prepare(
      `SELECT person_id, event_people_id, first_name, last_name, profile_json, photo_url,
              CASE WHEN LOWER(first_name || ' ' || last_name) LIKE ? THEN 0 ELSE 1 END
                AS name_prefix_rank
       FROM swapcard_attendees
       WHERE ${whereSql}
       ${searchOrderByClause()}
       LIMIT ? OFFSET ?`
    )
    .all(...pageParams) as {
    person_id: string | null;
    event_people_id: string | null;
    first_name: string;
    last_name: string;
    profile_json: string;
    photo_url: string | null;
    name_prefix_rank: number;
  }[];

  return {
    results: rows.map(projectSearchRow),
    total: totalRow.c,
  };
}

// Global cosine-ranked variant of searchSwapcardAttendees. Runs the same
// WHERE filter (query + cause-area) but selects ALL matching rows along with
// their embedding, scores each one against the supplied requester embedding,
// then slices to (offset, limit). Use when the caller wants "closest people
// first" *across the entire filtered set* — the alphabetical variant + a
// per-page client-side re-rank only sorts within each scroll page, which
// doesn't match user expectations for /people?sort=closeness.
//
// Cost: O(N × dim) per call (N = filtered row count). For EAG-2026 N≈2778 and
// dim=384, that's ~1M floats per call — ~100ms on the slop2 box. We don't
// cache; the WHERE filter changes per query and the embedding is per-handle.
//
// Tie-break is alphabetical so equal-score rows (stub embeddings, two
// near-identical bios) don't jitter while scrolling.
export function searchSwapcardAttendeesByCloseness(
  eventId: string,
  query: string,
  requesterEmbedding: Buffer,
  limit = 50,
  offset = 0,
  causeArea?: string
): { results: SwapcardAttendeeSearchResult[]; total: number } {
  // Convert the requester's blob to a vector ONCE. The corpus loop reads each
  // row's blob inline (Float32Array view over the Buffer) and dots against it.
  // We assume embeddings are pre-normalised, so cosine = dot product.
  const dim = requesterEmbedding.length / 4;
  const myVec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) myVec[i] = requesterEmbedding.readFloatLE(i * 4);

  // Reuse the same WHERE assembly logic as searchSwapcardAttendees so the
  // total count stays in lockstep — but project the embedding too. Token
  // sanitisation (cap length, strip %/_, cap token count) mirrors that
  // function exactly because the same defenses apply here.
  const causeAreaTrimmed = causeArea?.trim() ?? "";
  const causeAreaClause = causeAreaTrimmed
    ? ` AND EXISTS (
          SELECT 1 FROM json_each(json_extract(profile_json, '$.interests'))
          WHERE LOWER(value) = LOWER(?)
        )`
    : "";
  const causeAreaParam: string[] = causeAreaTrimmed ? [causeAreaTrimmed] : [];

  if (query.length > 100) query = query.slice(0, 100);
  const trimmed = query.trim();

  type RawRow = {
    person_id: string | null;
    event_people_id: string | null;
    first_name: string;
    last_name: string;
    profile_json: string;
    photo_url: string | null;
    embedding: Buffer;
  };

  let rows: RawRow[];
  if (trimmed.length === 0) {
    rows = db
      .prepare(
        `SELECT person_id, event_people_id, first_name, last_name, profile_json, photo_url, embedding
         FROM swapcard_attendees
         WHERE event_id = ?${causeAreaClause}`
      )
      .all(eventId, ...causeAreaParam) as RawRow[];
  } else {
    let tokens = trimmed
      .toLowerCase()
      .split(/\s+/)
      .map((tok) => tok.replace(/[%_]/g, ""))
      .filter(Boolean);
    tokens = tokens.slice(0, 8);
    if (tokens.length === 0) {
      rows = db
        .prepare(
          `SELECT person_id, event_people_id, first_name, last_name, profile_json, photo_url, embedding
           FROM swapcard_attendees
           WHERE event_id = ?${causeAreaClause}`
        )
        .all(eventId, ...causeAreaParam) as RawRow[];
    } else {
      const perTokenClause = `(
        LOWER(first_name) LIKE ?
        OR LOWER(last_name) LIKE ?
        OR LOWER(first_name || ' ' || last_name) LIKE ?
        OR LOWER(COALESCE(json_extract(profile_json, '$.jobTitle'), '')) LIKE ?
        OR LOWER(COALESCE(json_extract(profile_json, '$.company'), '')) LIKE ?
        OR LOWER(COALESCE(json_extract(profile_json, '$.biography'), '')) LIKE ?
        OR EXISTS (
          SELECT 1 FROM json_each(json_extract(profile_json, '$.expertise'))
          WHERE LOWER(value) LIKE ?
        )
        OR EXISTS (
          SELECT 1 FROM json_each(json_extract(profile_json, '$.interests'))
          WHERE LOWER(value) LIKE ?
        )
      )`;
      const COLS_PER_TOKEN = 8;
      const whereClauses: string[] = ["event_id = ?"];
      const params: (string | number)[] = [eventId];
      for (const tok of tokens) {
        whereClauses.push(perTokenClause);
        const pat = `%${tok}%`;
        for (let i = 0; i < COLS_PER_TOKEN; i++) params.push(pat);
      }
      if (causeAreaTrimmed) {
        whereClauses.push(`EXISTS (
          SELECT 1 FROM json_each(json_extract(profile_json, '$.interests'))
          WHERE LOWER(value) = LOWER(?)
        )`);
        params.push(causeAreaTrimmed);
      }
      const whereSql = whereClauses.join(" AND ");
      rows = db
        .prepare(
          `SELECT person_id, event_people_id, first_name, last_name, profile_json, photo_url, embedding
           FROM swapcard_attendees
           WHERE ${whereSql}`
        )
        .all(...params) as RawRow[];
    }
  }

  // Score every matching row. Stub rows have a zero-embedding (NOT NULL but
  // all-zero buffer), so cosine collapses to 0 for them and they sink below
  // any real signal but above the alphabetical-tail of -∞ misses.
  const scored = rows.map((r) => {
    let score = 0;
    const buf = r.embedding;
    // Read inline: avoids allocating a full Float32Array per row, which
    // matters when N is large enough to make GC visible.
    for (let i = 0; i < dim; i++) {
      score += myVec[i] * buf.readFloatLE(i * 4);
    }
    return { row: r, score };
  });

  // Sort by score desc; alphabetical tie-break keeps the order stable while
  // pagination cursors over equal-scored rows (otherwise the user sees a
  // different "offset 50" row than the one they expected to see next).
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aName = `${a.row.first_name} ${a.row.last_name}`.toLowerCase();
    const bName = `${b.row.first_name} ${b.row.last_name}`.toLowerCase();
    if (aName !== bName) return aName < bName ? -1 : 1;
    return 0;
  });

  const total = scored.length;
  const slice = scored.slice(offset, offset + limit);
  return {
    results: slice.map(({ row }) => projectSearchRow(row)),
    total,
  };
}

// Pull the three profile fields the search UI shows out of the JSON blob.
// Done once per row here instead of in the SQL projection because better-
// sqlite3 returns json_extract values as strings and we'd just be parsing
// the same blob three times.
function projectSearchRow(r: {
  person_id: string | null;
  event_people_id: string | null;
  first_name: string;
  last_name: string;
  profile_json: string;
  photo_url: string | null;
}): SwapcardAttendeeSearchResult {
  let jobTitle = "";
  let company = "";
  let country = "";
  let swapcardUrl = "";
  try {
    const p = JSON.parse(r.profile_json) as {
      jobTitle?: string;
      company?: string;
      country?: string;
      swapcardUrl?: string;
    };
    jobTitle = typeof p.jobTitle === "string" ? p.jobTitle : "";
    company = typeof p.company === "string" ? p.company : "";
    country = typeof p.country === "string" ? p.country : "";
    swapcardUrl = typeof p.swapcardUrl === "string" ? p.swapcardUrl : "";
  } catch {
    /* malformed row — surface empties rather than crashing the whole page */
  }
  // Fallback: rows attached to an EventPeople ID (via scrape) but whose
  // profile_json doesn't carry an explicit swapcardUrl (sheet column was
  // blank, or it's a stub) — synthesize the canonical app.swapcard.com URL
  // so /people still renders an "open →" link. Slug is configurable via
  // SWAPCARD_EVENT_SLUG to match /agenda's session links.
  if (!swapcardUrl && r.event_people_id) {
    const slug = process.env.SWAPCARD_EVENT_SLUG || "eag-london";
    swapcardUrl = `https://app.swapcard.com/event/${slug}/person/${encodeURIComponent(r.event_people_id)}`;
  }
  return {
    personId: r.person_id,
    eventPeopleId: r.event_people_id,
    firstName: r.first_name,
    lastName: r.last_name,
    jobTitle,
    company,
    country,
    swapcardUrl,
    hasPhoto: r.photo_url !== null,
  };
}

export function listSwapcardAttendees(eventId: string): SwapcardAttendeeRow[] {
  const rows = db
    .prepare(
      `SELECT ${SWAPCARD_ATTENDEE_COLS} FROM swapcard_attendees WHERE event_id = ?`
    )
    .all(eventId) as SwapcardAttendeeDbRow[];
  return rows.map(toSwapcardAttendee);
}

// Minimal projection for the match-event-people name index. Returns ALL rows
// for the event (including ones with NULL person_id — those are sheet
// attendees who filled the registration without supplying their Swapcard URL,
// and still need to be matched by name). The row `id` lets the matcher update
// rows that don't have a CommunityProfile key.
export interface SwapcardAttendeeNameRow {
  id: number;
  personId: string | null;
  eventPeopleId: string | null;
  firstName: string;
  lastName: string;
  // Sheet-side company string, projected out of profile_json so the matcher
  // can disambiguate ambiguous name collisions ("Ben Stewart" appears 4× in
  // the sheet, twice with each company). Empty string when the sheet column
  // was blank or malformed.
  company: string;
}
export function listSwapcardAttendeeNameRows(
  eventId: string
): SwapcardAttendeeNameRow[] {
  const rows = db
    .prepare(
      `SELECT id, person_id, event_people_id, first_name, last_name,
              COALESCE(json_extract(profile_json, '$.company'), '') AS company
       FROM swapcard_attendees WHERE event_id = ?`
    )
    .all(eventId) as {
    id: number;
    person_id: string | null;
    event_people_id: string | null;
    first_name: string;
    last_name: string;
    company: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    personId: r.person_id,
    eventPeopleId: r.event_people_id,
    firstName: r.first_name,
    lastName: r.last_name,
    company: r.company ?? "",
  }));
}

// Process-lifetime cache for `listAttendeeInterests`. The set of distinct
// `profile_json.interests[]` values only changes when the sheet is re-ingested;
// reading from cache lets the /people dropdown render without a JSON-walk on
// every request. Cache key includes sheet signature so a fresh ingest
// invalidates automatically.
const _interestsCache = new Map<string, { sig: string; values: string[] }>();

// Union of all `profile_json.interests[]` values across the event, sorted
// alphabetically and case-folded for stable dedupe. Used by the /people
// cause-area dropdown. Costs one full-table scan + JSON parse per ingest, then
// served from in-process memory.
export function listAttendeeInterests(eventId: string): string[] {
  const sig = getSheetSignature(eventId) ?? "";
  const cached = _interestsCache.get(eventId);
  if (cached && cached.sig === sig) return cached.values;
  const rows = db
    .prepare(
      "SELECT profile_json FROM swapcard_attendees WHERE event_id = ?"
    )
    .all(eventId) as { profile_json: string }[];
  // Dedupe case-insensitively but keep the FIRST casing we see — common case
  // is the sheet uses consistent casing per cause-area, and folding to all-
  // lower would lose acronyms like "AI safety".
  const seen = new Map<string, string>();
  for (const r of rows) {
    let interests: unknown;
    try {
      interests = (JSON.parse(r.profile_json) as { interests?: unknown })
        .interests;
    } catch {
      continue;
    }
    if (!Array.isArray(interests)) continue;
    for (const v of interests) {
      if (typeof v !== "string") continue;
      const trimmed = v.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (!seen.has(key)) seen.set(key, trimmed);
    }
  }
  const values = Array.from(seen.values()).sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
  _interestsCache.set(eventId, { sig, values });
  return values;
}

// Test hook — flushes the in-process interests cache so tests that mutate
// rows can observe the new set without restarting the process.
export function __resetAttendeeInterestsCache(): void {
  _interestsCache.clear();
}

export interface SwapcardAttendeeIngestRow {
  personId: string | null;
  firstName: string;
  lastName: string;
  profileJson: string;
  embedding: Buffer;
  sheetSignature: string;
}

/**
 * Replace the entire cached attendee set for `eventId` atomically. Old rows
 * are deleted first; the inserts happen in a single transaction so a partial
 * write can't leave the discover path observing half a sheet. event_people_id
 * is populated separately by the GraphQL scrape job, so the ingest path
 * doesn't write it here.
 */
export function replaceSwapcardAttendees(
  eventId: string,
  rows: SwapcardAttendeeIngestRow[],
  fetchedAt: number
): void {
  const tx = db.transaction((rs: SwapcardAttendeeIngestRow[]) => {
    db.prepare("DELETE FROM swapcard_attendees WHERE event_id = ?").run(eventId);
    const stmt = db.prepare(
      `INSERT INTO swapcard_attendees
         (event_id, person_id, first_name, last_name, profile_json, embedding, sheet_signature, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of rs) {
      stmt.run(
        eventId,
        r.personId,
        r.firstName,
        r.lastName,
        r.profileJson,
        r.embedding,
        r.sheetSignature,
        fetchedAt
      );
    }
  });
  tx(rows);
}

// ── Discover run cache ───────────────────────────────────────────────────────

export interface StoredDiscoverRun {
  id: number;
  handle: string;
  eventId: string;
  sheetSignature: string;
  payloadJson: string;
  createdAt: number;
}

export function getLatestDiscoverRun(
  handle: string,
  eventId: string,
  sheetSignature: string
): StoredDiscoverRun | null {
  const row = db
    .prepare(
      "SELECT id, handle, event_id, sheet_signature, payload_json, created_at FROM swapcard_discover_runs WHERE handle = ? AND event_id = ? AND sheet_signature = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(handle.toLowerCase(), eventId, sheetSignature) as
    | {
        id: number;
        handle: string;
        event_id: string;
        sheet_signature: string;
        payload_json: string;
        created_at: number;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    handle: row.handle,
    eventId: row.event_id,
    sheetSignature: row.sheet_signature,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
  };
}

// Returns the inserted row id. Callers stamp it onto the run payload so
// future fetches (e.g. the share-link permalink) can address this specific
// run, and the cached payload echoes its own id without an extra DB read.
export function insertDiscoverRun(
  handle: string,
  eventId: string,
  sheetSignature: string,
  payloadJson: string
): number {
  const result = db
    .prepare(
      "INSERT INTO swapcard_discover_runs (handle, event_id, sheet_signature, payload_json, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(handle.toLowerCase(), eventId, sheetSignature, payloadJson, Date.now());
  return Number(result.lastInsertRowid);
}

// Rewrites the cached JSON for a single run. Used by the orchestrator to
// re-stamp the payload with its own row id immediately after insert; not
// intended for general use.
export function updateDiscoverRunPayload(id: number, payloadJson: string): void {
  db.prepare(
    "UPDATE swapcard_discover_runs SET payload_json = ? WHERE id = ?"
  ).run(payloadJson, id);
}

// Fetch a single stored run by its row id. Deliberately NOT filtered by
// handle here — the caller (the permalink page) does the owner check after
// loading, so it can decide between 403 vs 404 instead of leaking which.
export function getDiscoverRunById(id: number): StoredDiscoverRun | null {
  const row = db
    .prepare(
      "SELECT id, handle, event_id, sheet_signature, payload_json, created_at FROM swapcard_discover_runs WHERE id = ?"
    )
    .get(id) as
    | {
        id: number;
        handle: string;
        event_id: string;
        sheet_signature: string;
        payload_json: string;
        created_at: number;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    handle: row.handle,
    eventId: row.event_id,
    sheetSignature: row.sheet_signature,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
  };
}

// Lightweight summary for a /discover/history row. Keeps the payload JSON
// out of the result so the page can render hundreds of cheap entries without
// shipping ~MB per run over the wire. The caller derives picks-count + sheet
// signature already-stored on the run record; we don't parse payload_json
// here to keep this query allocation-free.
export interface DiscoverRunSummary {
  id: number;
  eventId: string;
  sheetSignature: string;
  createdAt: number;
  recommendationCount: number;
  totalAttendees: number;
}

export function listDiscoverRunsForHandle(
  handle: string,
  limit = 20
): DiscoverRunSummary[] {
  // Secondary id DESC sort handles same-millisecond ties — common when
  // tests insert in tight loops, but also possible in prod under burst
  // conditions. Stable newest-first ordering either way.
  const rows = db
    .prepare(
      "SELECT id, event_id, sheet_signature, payload_json, created_at FROM swapcard_discover_runs WHERE handle = ? ORDER BY created_at DESC, id DESC LIMIT ?"
    )
    .all(handle.toLowerCase(), limit) as {
    id: number;
    event_id: string;
    sheet_signature: string;
    payload_json: string;
    created_at: number;
  }[];
  return rows.map((r) => {
    // Parse just the two summary fields we need. JSON.parse on a 100KB blob
    // is ~1ms and these queries cap at 20 rows, so the cost is negligible.
    let recommendationCount = 0;
    let totalAttendees = 0;
    try {
      const p = JSON.parse(r.payload_json) as {
        recommendations?: unknown[];
        totalAttendees?: number;
      };
      recommendationCount = Array.isArray(p.recommendations)
        ? p.recommendations.length
        : 0;
      totalAttendees = typeof p.totalAttendees === "number" ? p.totalAttendees : 0;
    } catch {
      /* ignore — leave defaults */
    }
    return {
      id: r.id,
      eventId: r.event_id,
      sheetSignature: r.sheet_signature,
      createdAt: r.created_at,
      recommendationCount,
      totalAttendees,
    };
  });
}

// ── Attendee meeting-slot cache ──────────────────────────────────────────────

// Upsert a slot snapshot for one attendee. slotsJson is the serialised
// MeetSlot[] from scrape-agenda.ts; we don't validate shape here — callers
// own that. The (event_id, event_people_id) UNIQUE index drives the ON
// CONFLICT clause, so re-running the admin refresh overwrites in place
// instead of appending duplicates.
export function setAttendeeSlots(
  eventId: string,
  eventPeopleId: string,
  slotsJson: string
): void {
  db.prepare(
    `INSERT INTO attendee_slots (event_id, event_people_id, slots_json, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(event_id, event_people_id) DO UPDATE SET
       slots_json = excluded.slots_json,
       fetched_at = excluded.fetched_at`
  ).run(eventId, eventPeopleId, slotsJson, Date.now());
}

// Read one cached slot snapshot. Returns null when no row exists OR when the
// row is older than maxAgeSec — the caller treats both cases identically
// (count is "unknown"). Centralising the staleness check here keeps the TTL
// rule in one place instead of scattered across orchestrators.
export function getAttendeeSlots(
  eventId: string,
  eventPeopleId: string,
  maxAgeSec: number
): { slotsJson: string; fetchedAt: number } | null {
  const row = db
    .prepare(
      "SELECT slots_json, fetched_at FROM attendee_slots WHERE event_id = ? AND event_people_id = ?"
    )
    .get(eventId, eventPeopleId) as
    | { slots_json: string; fetched_at: number }
    | undefined;
  if (!row) return null;
  if (Date.now() - row.fetched_at > maxAgeSec * 1000) return null;
  return { slotsJson: row.slots_json, fetchedAt: row.fetched_at };
}

// Bulk slot-COUNT lookup used by /discover to annotate recs. Returns only
// the count per attendee — not the full JSON — because the discover payload
// only needs to render "N free slots" badges. Stale rows are filtered out
// at SQL level so the orchestrator doesn't have to re-check each one.
// Missing or stale → simply absent from the map (caller treats absent as
// "unknown" and renders no badge). Empty input array short-circuits to an
// empty map without hitting SQLite.
export function listFreshAttendeeSlotCounts(
  eventId: string,
  eventPeopleIds: string[],
  maxAgeSec: number
): Map<string, number> {
  const out = new Map<string, number>();
  if (eventPeopleIds.length === 0) return out;
  const cutoff = Date.now() - maxAgeSec * 1000;
  // Build a parameter list for the IN clause. better-sqlite3 doesn't
  // expand arrays automatically, so we generate placeholders manually.
  const placeholders = eventPeopleIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT event_people_id, slots_json FROM attendee_slots
       WHERE event_id = ? AND fetched_at >= ? AND event_people_id IN (${placeholders})`
    )
    .all(eventId, cutoff, ...eventPeopleIds) as {
    event_people_id: string;
    slots_json: string;
  }[];
  for (const r of rows) {
    let count = 0;
    try {
      const parsed = JSON.parse(r.slots_json);
      if (Array.isArray(parsed)) count = parsed.length;
    } catch {
      /* malformed row — treat as zero rather than poisoning the whole map */
    }
    out.set(r.event_people_id, count);
  }
  return out;
}

// All event_people_ids we have an attendee cache row for. Used by the admin
// refresh endpoint to decide who to scrape slots for when no explicit
// peopleIds list is provided in the request body.
export function listAttendeesWithEventPeopleId(eventId: string): string[] {
  const rows = db
    .prepare(
      "SELECT event_people_id FROM swapcard_attendees WHERE event_id = ? AND event_people_id IS NOT NULL"
    )
    .all(eventId) as { event_people_id: string }[];
  return rows.map((r) => r.event_people_id);
}

// ── Event-agenda session cache ───────────────────────────────────────────────

/**
 * Replace the entire cached session set for `eventId` atomically. Old rows
 * are deleted first; the inserts happen in a single transaction so a partial
 * write can't leave the /agenda path observing half a schedule. The full
 * ScrapedSession is duplicated into `payload_json` so future UI additions
 * (e.g. surfacing maxSeats/categories) don't require a re-scrape.
 */
export function replaceEventSessions(
  eventId: string,
  sessions: ScrapedSession[]
): void {
  const tx = db.transaction((rs: ScrapedSession[]) => {
    db.prepare("DELETE FROM event_sessions WHERE event_id = ?").run(eventId);
    const stmt = db.prepare(
      `INSERT INTO event_sessions
         (event_id, planning_id, title, begins_at, ends_at, place, format, description_html, payload_json, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const now = Date.now();
    for (const s of rs) {
      stmt.run(
        eventId,
        s.planningId,
        s.title,
        s.beginsAt,
        s.endsAt,
        s.place,
        s.format,
        s.description,
        JSON.stringify(s),
        now
      );
    }
  });
  tx(sessions);
}

// Ordered list of cached sessions for an event, oldest-first. Ordering is
// stable across re-renders: primary by begins_at, secondary by planning_id
// to break ties for concurrent sessions starting at exactly the same minute.
// The payload JSON is the source of truth for fields the page renders, since
// it carries categories + speakers that aren't in dedicated columns.
export function listEventSessions(eventId: string): ScrapedSession[] {
  const rows = db
    .prepare(
      "SELECT payload_json FROM event_sessions WHERE event_id = ? ORDER BY begins_at ASC, planning_id ASC"
    )
    .all(eventId) as { payload_json: string }[];
  const out: ScrapedSession[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.payload_json) as ScrapedSession);
    } catch {
      /* malformed row — skip rather than poisoning the whole page */
    }
  }
  return out;
}

// Most-recent fetched_at across all cached sessions for this event. Used to
// render "cached N hours ago" on /agenda. Returns null when no rows exist so
// the page can show the "no sessions cached" copy.
export function getEventSessionsFetchedAt(eventId: string): number | null {
  const row = db
    .prepare(
      "SELECT MAX(fetched_at) AS last FROM event_sessions WHERE event_id = ?"
    )
    .get(eventId) as { last: number | null } | undefined;
  return row?.last ?? null;
}

// ── Saved-attendees lookup (for /saved) ──────────────────────────────────────

// Shape returned to /saved. Mirrors SwapcardAttendeeSearchResult for the
// header fields but adds `slotStarts` so the page can compute overlap with
// the requester's own slots without a second round-trip.
export interface SavedAttendeeRow {
  personId: string | null;
  eventPeopleId: string | null;
  firstName: string;
  lastName: string;
  jobTitle: string;
  company: string;
  country: string;
  hasPhoto: boolean;
  swapcardUrl: string;
  // Free-slot starts ISO strings — used for overlap math. Empty array if
  // the user has no cached slot data for this attendee.
  slotStarts: string[];
}

// Resolve a list of saved IDs (CommunityProfile_* OR EventPeople_* — the
// bookmark store mixes both schemes since /people writes whichever ID it
// has) to attendee rows + their cached free slots. Preserves input order so
// the UI can render "the order you starred them in" before re-sorting by
// overlap. Skips IDs that don't match a row rather than returning placeholders
// — those IDs typically refer to attendees who weren't in the most recent
// sheet ingest.
export function listSavedAttendees(
  eventId: string,
  anyIds: string[],
  slotMaxAgeSec: number
): SavedAttendeeRow[] {
  if (anyIds.length === 0) return [];

  // Single IN-clause query for the attendee rows so we make one DB round-trip
  // regardless of save-list length. Deduped because the same person could
  // appear under both ID schemes in the user's localStorage.
  const dedup = Array.from(new Set(anyIds));
  const placeholders = dedup.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT person_id, event_people_id, first_name, last_name, profile_json, photo_url
       FROM swapcard_attendees
       WHERE event_id = ?
         AND (person_id IN (${placeholders}) OR event_people_id IN (${placeholders}))`
    )
    .all(eventId, ...dedup, ...dedup) as {
    person_id: string | null;
    event_people_id: string | null;
    first_name: string;
    last_name: string;
    profile_json: string;
    photo_url: string | null;
  }[];

  // Map both ID schemes back to the row so we can preserve input order in O(n).
  // A single row can be reachable via either ID, so we register under both keys.
  const byAnyId = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (r.person_id) byAnyId.set(r.person_id, r);
    if (r.event_people_id) byAnyId.set(r.event_people_id, r);
  }

  // Now batch-fetch fresh slots for everyone we matched. Skip rows with no
  // event_people_id since the slot cache is keyed by it.
  const eventPeopleIds = rows
    .map((r) => r.event_people_id)
    .filter((x): x is string => x !== null);
  const slotsByEventPeopleId = new Map<string, string[]>();
  if (eventPeopleIds.length > 0) {
    const cutoff = Date.now() - slotMaxAgeSec * 1000;
    const slotPlaceholders = eventPeopleIds.map(() => "?").join(",");
    const slotRows = db
      .prepare(
        `SELECT event_people_id, slots_json FROM attendee_slots
         WHERE event_id = ? AND fetched_at >= ? AND event_people_id IN (${slotPlaceholders})`
      )
      .all(eventId, cutoff, ...eventPeopleIds) as {
      event_people_id: string;
      slots_json: string;
    }[];
    for (const sr of slotRows) {
      const starts: string[] = [];
      try {
        const parsed = JSON.parse(sr.slots_json);
        if (Array.isArray(parsed)) {
          for (const s of parsed) {
            if (s && typeof s.starts === "string") starts.push(s.starts);
          }
        }
      } catch {
        /* malformed row — empty starts so the row still renders */
      }
      slotsByEventPeopleId.set(sr.event_people_id, starts);
    }
  }

  // Walk the input order, projecting profile JSON once per matched row. A
  // Set tracks rows we've already emitted so duplicate IDs (e.g. a user
  // saving the same person under both schemes) only produce one card.
  const emitted = new Set<(typeof rows)[number]>();
  const out: SavedAttendeeRow[] = [];
  for (const id of anyIds) {
    const r = byAnyId.get(id);
    if (!r) continue;
    if (emitted.has(r)) continue;
    emitted.add(r);
    let jobTitle = "";
    let company = "";
    let country = "";
    let swapcardUrl = "";
    try {
      const p = JSON.parse(r.profile_json) as {
        jobTitle?: string;
        company?: string;
        country?: string;
        swapcardUrl?: string;
      };
      jobTitle = typeof p.jobTitle === "string" ? p.jobTitle : "";
      company = typeof p.company === "string" ? p.company : "";
      country = typeof p.country === "string" ? p.country : "";
      swapcardUrl = typeof p.swapcardUrl === "string" ? p.swapcardUrl : "";
    } catch {
      /* malformed row — surface empties rather than crashing the page */
    }
    out.push({
      personId: r.person_id,
      eventPeopleId: r.event_people_id,
      firstName: r.first_name,
      lastName: r.last_name,
      jobTitle,
      company,
      country,
      hasPhoto: r.photo_url !== null,
      swapcardUrl,
      slotStarts: r.event_people_id
        ? (slotsByEventPeopleId.get(r.event_people_id) ?? [])
        : [],
    });
  }
  return out;
}

// ── Swapcard link-request approval queue ─────────────────────────────────────

export type LinkRequestState = "pending" | "approved" | "rejected";

export interface LinkRequestRow {
  id: number;
  handle: string;
  personId: string;
  eventId: string;
  linkedName: string;
  state: LinkRequestState;
  approveToken: string;
  requestedAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
}

interface LinkRequestDbRow {
  id: number;
  handle: string;
  person_id: string;
  event_id: string;
  linked_name: string;
  state: LinkRequestState;
  approve_token: string;
  requested_at: number;
  decided_at: number | null;
  decided_by: string | null;
}

const toLinkRequest = (r: LinkRequestDbRow): LinkRequestRow => ({
  id: r.id,
  handle: r.handle,
  personId: r.person_id,
  eventId: r.event_id,
  linkedName: r.linked_name,
  state: r.state,
  approveToken: r.approve_token,
  requestedAt: r.requested_at,
  decidedAt: r.decided_at,
  decidedBy: r.decided_by,
});

/**
 * Create a pending link request, or return the existing pending one for the
 * same (handle, personId). The partial unique index on (handle, person_id)
 * WHERE state = 'pending' is what makes this idempotent — once a row is
 * decided (approved/rejected), a fresh POST creates a brand-new pending row.
 */
export function createPendingLinkRequest(args: {
  handle: string;
  personId: string;
  eventId: string;
  linkedName: string;
}): { id: number; approveToken: string } {
  const handle = args.handle.toLowerCase();
  const existing = db
    .prepare(
      "SELECT id, approve_token FROM swapcard_link_requests WHERE handle = ? AND person_id = ? AND state = 'pending'"
    )
    .get(handle, args.personId) as
    | { id: number; approve_token: string }
    | undefined;
  if (existing) {
    return { id: existing.id, approveToken: existing.approve_token };
  }
  const token = crypto.randomBytes(24).toString("hex");
  const result = db
    .prepare(
      `INSERT INTO swapcard_link_requests
         (handle, person_id, event_id, linked_name, state, approve_token, requested_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`
    )
    .run(handle, args.personId, args.eventId, args.linkedName, token, Date.now());
  return { id: Number(result.lastInsertRowid), approveToken: token };
}

export function getLinkRequestByToken(token: string): LinkRequestRow | null {
  const row = db
    .prepare("SELECT * FROM swapcard_link_requests WHERE approve_token = ?")
    .get(token) as LinkRequestDbRow | undefined;
  return row ? toLinkRequest(row) : null;
}

export function getLinkRequestById(id: number): LinkRequestRow | null {
  const row = db
    .prepare("SELECT * FROM swapcard_link_requests WHERE id = ?")
    .get(id) as LinkRequestDbRow | undefined;
  return row ? toLinkRequest(row) : null;
}

// Cheap "is there anything to do?" check. The admin banner on every page
// hits this on every request; a COUNT(*) is far cheaper than listing rows
// just to read .length. Bounds the layout's per-request DB work to one
// indexed scan over rows where state='pending' (which is small — pending
// rows are decided within minutes).
export function countPendingLinkRequests(): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM swapcard_link_requests WHERE state = 'pending'")
    .get() as { n: number };
  return row.n;
}

export function listPendingLinkRequests(limit = 100): LinkRequestRow[] {
  const rows = db
    .prepare(
      "SELECT * FROM swapcard_link_requests WHERE state = 'pending' ORDER BY requested_at DESC LIMIT ?"
    )
    .all(limit) as LinkRequestDbRow[];
  return rows.map(toLinkRequest);
}

// Recent link requests for one handle (any state). Used by the /link page to
// surface "pending admin approval" / "your last request was rejected" notices
// so the user doesn't sit refreshing wondering whether their submission was
// queued. Handle lookup is case-insensitive to match createPendingLinkRequest.
export function listLinkRequestsForHandle(
  handle: string,
  limit = 10
): LinkRequestRow[] {
  const rows = db
    .prepare(
      "SELECT * FROM swapcard_link_requests WHERE handle = ? ORDER BY requested_at DESC LIMIT ?"
    )
    .all(handle.toLowerCase(), limit) as LinkRequestDbRow[];
  return rows.map(toLinkRequest);
}

export function decideLinkRequest(
  id: number,
  state: "approved" | "rejected",
  actor: string
): LinkRequestRow | null {
  const existing = getLinkRequestById(id);
  if (!existing) return null;
  db.prepare(
    "UPDATE swapcard_link_requests SET state = ?, decided_at = ?, decided_by = ? WHERE id = ?"
  ).run(state, Date.now(), actor, id);
  return getLinkRequestById(id);
}

export default db;
