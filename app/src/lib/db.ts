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
});

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

export interface SubmitInput {
  handle: string;
  displayName: string;
  description: string;
  avatarUrl: string;
  swapcardUrl: string;
  submitterIp: string | null;
}

export function createPendingCard(input: SubmitInput): Card {
  const now = Date.now();
  const handle = input.handle.toLowerCase();
  const token = crypto.randomBytes(16).toString("hex");
  db.prepare(
    `INSERT INTO cards (handle, display_name, description, avatar_url, swapcard_url, status, preview_token, submitter_ip, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).run(
    handle,
    input.displayName,
    input.description,
    input.avatarUrl,
    input.swapcardUrl,
    token,
    input.submitterIp,
    now,
    now
  );
  return getCard(handle)!;
}

export type CardEdits = Partial<
  Pick<Card, "displayName" | "description" | "avatarUrl" | "swapcardUrl">
>;

export function updateCardFields(handle: string, edits: CardEdits): Card | null {
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
  return getCard(handle);
}

export function approveCard(handle: string, edits?: CardEdits): Card | null {
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
  return getCard(handle);
}

export function deleteCard(handle: string): boolean {
  const res = db
    .prepare("DELETE FROM cards WHERE handle = ?")
    .run(handle.toLowerCase());
  return res.changes > 0;
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
  input: SubmitInput & { twitterId: string }
): Card {
  const now = Date.now();
  const handle = input.handle.toLowerCase();
  const token = crypto.randomBytes(16).toString("hex");
  db.prepare(
    `INSERT INTO cards (handle, display_name, description, avatar_url, swapcard_url,
                        status, preview_token, submitter_ip,
                        verified_twitter_id, verified_at,
                        created_at, updated_at, approved_at)
     VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?)`
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
    now,
    now,
    now
  );
  return getCard(handle)!;
}

export default db;
