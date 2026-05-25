import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "fs";
import path from "path";
import crypto from "crypto";

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

// Append-only audit log. Never updated, only inserted. Captures every
// mutation to a card with full before/after snapshots so deleted data isn't
// lost and changes are auditable. Querying for "current state" stays on the
// `cards` table — this is only read for history.
db.exec(`
  CREATE TABLE IF NOT EXISTS card_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    handle       TEXT NOT NULL,
    action       TEXT NOT NULL,   -- create | create_verified | update | approve | delete
    actor        TEXT NOT NULL,   -- anon:<ip> | verified:<twitter_id> | admin
    before_json  TEXT,            -- snapshot of card BEFORE the action (NULL for creates)
    after_json   TEXT             -- snapshot of card AFTER the action (NULL for deletes)
  );
  CREATE INDEX IF NOT EXISTS card_events_handle ON card_events(handle);
  CREATE INDEX IF NOT EXISTS card_events_ts ON card_events(ts);
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
});

export type CardEventAction =
  | "create"
  | "create_verified"
  | "update"
  | "approve"
  | "delete";

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

export default db;
