// Ingest pipeline: pull the public attendee sheet, embed every profile with
// the local bge-small model, and write the result to SQLite atomically. Slow
// the first time (~minute for ~2300 rows + initial model download); fast on
// reruns since the model is cached on disk by transformers.js.
//
// Triggered by an admin-only API route so we don't tie startup to a network
// fetch. Idempotent — running again replaces the cache atomically.

import { createHash } from "crypto";
import { fetchAttendeeSheet } from "./sheet";
import { embedText } from "./embed-text";
import { embedTexts, vectorToBlob } from "./embed";
import { replaceSwapcardAttendees } from "../db";

export interface IngestResult {
  eventId: string;
  totalAttendees: number;
  sheetSignature: string;
  fetchedAt: number;
  embeddingsBuilt: number;
  durationMs: number;
}

export async function runIngest(opts?: {
  eventId?: string;
  onProgress?: (msg: string) => void;
}): Promise<IngestResult> {
  const t0 = Date.now();
  const log = opts?.onProgress ?? (() => undefined);
  log("Fetching attendee sheet...");
  const sheet = await fetchAttendeeSheet({ eventId: opts?.eventId });
  log(`Got ${sheet.attendees.length} attendees from sheet`);

  // Signature tags every row with the version of the sheet they came from.
  // Includes the personId set + name set so we catch additions, removals, and
  // material edits without diffing every field. Same scheme as kryjak's tool.
  const sig = sheetSignature(sheet.attendees);

  const texts = sheet.attendees.map(embedText);
  log(`Embedding ${texts.length} profiles (first run downloads the model)...`);
  const vectors = await embedTexts(texts, {
    batchSize: 32,
    onProgress: (done, total) => {
      if (done === total || done % 320 === 0) log(`  embedded ${done}/${total}`);
    },
  });

  const rows = sheet.attendees.map((a, i) => ({
    personId: a.personId,
    firstName: a.firstName,
    lastName: a.lastName,
    profileJson: JSON.stringify(a),
    embedding: vectorToBlob(vectors[i]),
    sheetSignature: sig,
  }));

  log("Writing to SQLite...");
  replaceSwapcardAttendees(sheet.eventId, rows, sheet.fetchedAt);
  const durationMs = Date.now() - t0;
  log(`Ingest complete in ${(durationMs / 1000).toFixed(1)}s`);

  return {
    eventId: sheet.eventId,
    totalAttendees: sheet.attendees.length,
    sheetSignature: sig,
    fetchedAt: sheet.fetchedAt,
    embeddingsBuilt: vectors.length,
    durationMs,
  };
}

function sheetSignature(
  attendees: { personId: string | null; firstName: string; lastName: string }[]
): string {
  const h = createHash("sha1");
  for (const a of attendees) {
    h.update(a.personId ?? `${a.firstName}|${a.lastName}`);
    h.update("\n");
  }
  return `${attendees.length}:${h.digest("hex").slice(0, 12)}`;
}
