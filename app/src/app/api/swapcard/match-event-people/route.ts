import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import {
  deleteSwapcardAttendeeByRowId,
  listSwapcardAttendeeNameRows,
  setSwapcardAttendeeEventPeopleAndPhoto,
  setSwapcardAttendeeEventPeopleAndPhotoByRowId,
  upsertSwapcardAttendeeStub,
  getSheetSignature,
} from "@/lib/db";
import { EMBED_DIM, vectorToBlob } from "@/lib/swapcard/embed";
import {
  normalizeName,
  scrapeEventPeople,
  type ScrapedAttendee,
} from "@/lib/swapcard/scrape-attendees";

export const dynamic = "force-dynamic";

// Admin-only: scrape Swapcard's EventPeople list using a bearer JWT the
// admin supplies, match each EventPeople record against our sheet attendees
// by normalised name, and store event_people_id + photo_url on each matched
// row. EventPeople records with no sheet match get a stub row so the user
// can still verify their URL even though they're not in the public sheet.
//
// The bearer token is consumed only for this request; nothing's persisted to
// disk.
//
// Body: { token: string, viewId?: string }
export async function POST(req: NextRequest) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }

  let body: { token?: unknown; viewId?: unknown };
  try {
    body = (await req.json()) as { token?: unknown; viewId?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) {
    return NextResponse.json(
      { error: "missing 'token' (Swapcard bearer JWT)" },
      { status: 400 }
    );
  }
  // Pin viewId to a server-configured allowlist. Without this an
  // admin-token leak amplifies into "scrape any Swapcard event view and
  // pollute our attendee cache with stub rows for personas the attacker
  // chooses" — the stubs satisfy linkSwapcardToCard's existence check.
  const allowedViewIds = (process.env.SWAPCARD_ALLOWED_VIEW_IDS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const rawViewId =
    typeof body.viewId === "string" && body.viewId.trim() ? body.viewId.trim() : undefined;
  if (rawViewId && allowedViewIds.length && !allowedViewIds.includes(rawViewId)) {
    return NextResponse.json(
      {
        error:
          "viewId not in SWAPCARD_ALLOWED_VIEW_IDS — refusing to scrape an arbitrary view",
      },
      { status: 400 }
    );
  }
  const viewId = rawViewId;

  const eventId = process.env.SWAPCARD_EVENT_ID || "eag-london-2026";
  const sheetSig =
    getSheetSignature(eventId) ?? `scrape-only:${new Date().toISOString()}`;

  try {
    const t0 = Date.now();
    const scrape = await scrapeEventPeople({
      bearerToken: token,
      viewId,
      onProgress: (n, total) => {
        if (n % 300 === 0 || n === total) {
          console.log(`[swapcard:match] scraped ${n}/${total || "?"}`);
        }
      },
    });
    console.log(
      `[swapcard:match] scrape done: ${scrape.attendees.length} rows in ${scrape.pagesFetched} pages`
    );

    // Build name → list of sheet attendees with that name. We INCLUDE rows
    // with NULL person_id — those are attendees who filled the sheet but left
    // the Swapcard URL column blank, so they can only be matched by name.
    // Older versions skipped them, which produced a duplicate "sheet row +
    // EventPeople stub" pair (the stub got the event_people_id; the sheet row
    // had no id at all — neither rendered a star nor a profile link).
    const sheetByName = new Map<string, ExistingRow[]>();
    const existingRows = listSwapcardAttendeeNameRows(eventId);
    for (const a of existingRows) {
      const key = normalizeName(`${a.firstName} ${a.lastName}`);
      const list = sheetByName.get(key) ?? [];
      list.push({
        id: a.id,
        personId: a.personId,
        eventPeopleId: a.eventPeopleId,
        firstName: a.firstName,
        lastName: a.lastName,
        company: a.company,
      });
      sheetByName.set(key, list);
    }

    let matched = 0;
    let mergedNullPersonId = 0; // sheet row matched by name (no person_id)
    let matchedByCompanyTiebreak = 0; // ambiguous-by-name, disambiguated by company
    let stubsInserted = 0;
    let stubsAbsorbed = 0; // existing stub got merged into a sheet row
    let ambiguous = 0;
    const ambiguousSamples: string[] = [];
    const zeroEmbedding = vectorToBlob(new Float32Array(EMBED_DIM));

    for (const scraped of scrape.attendees) {
      const key = normalizeName(`${scraped.firstName} ${scraped.lastName}`);
      const candidates = sheetByName.get(key) ?? [];

      // Prefer matching against a sheet row that has a person_id (the
      // canonical case from /sheets ingest). If only NULL-person_id sheet
      // rows are present, fall back to those. Stubs (person_id NULL AND
      // event_people_id NOT NULL with empty profile) get absorbed into the
      // sheet row if we can — see absorb step below.
      const withPersonId = candidates.filter((c) => c.personId !== null);
      const withoutPersonId = candidates.filter(
        (c) => c.personId === null && c.eventPeopleId === null
      );
      const orphanStubs = candidates.filter(
        (c) => c.personId === null && c.eventPeopleId !== null
      );

      // ── Canonical path: exactly one sheet row with a person_id. ────────
      if (withPersonId.length === 1) {
        // Delete same-name stubs FIRST so they don't collide with the
        // event_people_id UNIQUE constraint when we attach it to the
        // sheet row. The stub row had no useful profile content (zero
        // embedding, empty bio) and nothing references it by row id.
        for (const stub of orphanStubs) {
          deleteSwapcardAttendeeByRowId(stub.id);
          stubsAbsorbed += 1;
        }
        setSwapcardAttendeeEventPeopleAndPhoto(
          eventId,
          withPersonId[0].personId!,
          scraped.eventPeopleId,
          scraped.photoUrl
        );
        matched += 1;
        continue;
      }

      // ── Fallback: sheet row with NULL person_id (Swapcard URL column
      //    was blank). Attach by row id. Stub must be deleted first to
      //    avoid the event_people_id UNIQUE collision.
      if (withPersonId.length === 0 && withoutPersonId.length === 1) {
        for (const stub of orphanStubs) {
          deleteSwapcardAttendeeByRowId(stub.id);
          stubsAbsorbed += 1;
        }
        setSwapcardAttendeeEventPeopleAndPhotoByRowId(
          withoutPersonId[0].id,
          scraped.eventPeopleId,
          scraped.photoUrl
        );
        mergedNullPersonId += 1;
        continue;
      }

      // ── Ambiguous-by-name: try to disambiguate via company. If the
      //    EventPeople scrape gave us an organization AND exactly one of the
      //    candidate sheet rows has the same normalized company, attach to
      //    that one. This handles the "Ben Stewart at Longview vs Ben
      //    Stewart at Happier Lives" case — the scrape tells us which one
      //    we're looking at. Falls through to ambiguous otherwise.
      if (withPersonId.length + withoutPersonId.length > 1) {
        const scrapedCompanyKey = normalizeName(scraped.organization);
        if (scrapedCompanyKey) {
          const nameCandidates = [...withPersonId, ...withoutPersonId];
          const companyMatches = nameCandidates.filter(
            (c) => normalizeName(c.company) === scrapedCompanyKey
          );
          if (companyMatches.length === 1) {
            const winner = companyMatches[0];
            // Delete same-name stubs first (UNIQUE constraint guard).
            for (const stub of orphanStubs) {
              deleteSwapcardAttendeeByRowId(stub.id);
              stubsAbsorbed += 1;
            }
            if (winner.personId !== null) {
              setSwapcardAttendeeEventPeopleAndPhoto(
                eventId,
                winner.personId,
                scraped.eventPeopleId,
                scraped.photoUrl
              );
            } else {
              setSwapcardAttendeeEventPeopleAndPhotoByRowId(
                winner.id,
                scraped.eventPeopleId,
                scraped.photoUrl
              );
            }
            matchedByCompanyTiebreak += 1;
            continue;
          }
        }
        ambiguous += 1;
        if (ambiguousSamples.length < 5) {
          ambiguousSamples.push(`${scraped.firstName} ${scraped.lastName}`);
        }
        continue;
      }

      // ── No-sheet-match path: just a stub. orphanStubs (if any) is the
      //    previous run's stub for the same EventPeople id — upsert handles
      //    that idempotently.
      upsertSwapcardAttendeeStub({
        eventId,
        eventPeopleId: scraped.eventPeopleId,
        firstName: scraped.firstName,
        lastName: scraped.lastName,
        profileJson: JSON.stringify(buildStubProfile(scraped, eventId)),
        embedding: zeroEmbedding,
        photoUrl: scraped.photoUrl,
        sheetSignature: sheetSig,
      });
      stubsInserted += 1;
    }

    return NextResponse.json({
      ok: true,
      eventId,
      scraped: scrape.attendees.length,
      scrapeTotalReported: scrape.totalCount,
      pages: scrape.pagesFetched,
      matched,
      mergedNullPersonId,
      matchedByCompanyTiebreak,
      stubsInserted,
      stubsAbsorbed,
      ambiguous,
      ambiguousSamples,
      durationMs: Date.now() - t0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[swapcard:match] failed", e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

interface ExistingRow {
  id: number;
  personId: string | null;
  eventPeopleId: string | null;
  firstName: string;
  lastName: string;
  company: string;
}

// Minimal Attendee-shaped object for stub rows. EventPeople nodes give us
// jobTitle + organization for free; backfilling those onto stubs disambiguates
// genuine name collisions like four different "Ben Stewart"s on the floor.
function buildStubProfile(scraped: ScrapedAttendee, eventId: string) {
  return {
    eventId,
    personId: null,
    firstName: scraped.firstName,
    lastName: scraped.lastName,
    company: scraped.organization,
    jobTitle: scraped.jobTitle,
    careerStage: "",
    biography: "",
    expertise: [],
    interests: [],
    needHelp: "",
    helpOthers: "",
    country: "",
    seekingWork: "",
    recruitment: [],
    swapcardUrl: "",
    linkedinUrl: "",
  };
}
