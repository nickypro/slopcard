import Avatar from "@/components/Avatar";
import BookmarkStar from "@/components/BookmarkStar";
import SignInWithX from "@/components/SignInWithX";
import {
  getCard,
  getEventSessionsFetchedAt,
  listEventSessions,
} from "@/lib/db";
import { getUserSession } from "@/lib/session";
import type { ScrapedSession } from "@/lib/swapcard/scrape-agenda-events";

export const dynamic = "force-dynamic";

// The general conference agenda — talks, plenaries, workshops, sourced from
// Swapcard's PlanningListViewConnectionQuery via the admin refresh endpoint.
// Auth-gated the same way as /saved (session + linked Swapcard profile) —
// we don't want anonymous scrape-bait of the full schedule. The page reads
// from the event_sessions cache; freshness is whatever the admin's last
// `POST /api/swapcard/refresh-event-sessions` produced.
//
// Untrusted htmlDescription is NOT rendered here. Bringing it in would
// require a sanitiser pass (DOMPurify or equivalent) which we'll add when
// the description content is actually useful enough to justify the dep.
//
// Layout: Google-Calendar-style timeline view (≥641px) — vertical time axis,
// parallel-session columns derived from interval-graph greedy coloring. The
// mobile (≤640px) fallback is the original vertical list because the grid
// is unusable at phone widths.

export default async function AgendaPage() {
  const session = await getUserSession();
  const card = session ? getCard(session.twitterHandle) : null;
  const eventId = process.env.SWAPCARD_EVENT_ID || "eag-london-2026";

  // Only load the sessions when the gate passes — the empty branches above
  // don't need a DB hit. Saves a few ms on the unauthenticated path and
  // keeps the placeholder copy visible even when the cache is empty.
  const showAgenda = !!session && !!card?.swapcardPersonId;
  const sessions = showAgenda ? listEventSessions(eventId) : [];
  const fetchedAt = showAgenda ? getEventSessionsFetchedAt(eventId) : null;

  // Read the calendar-export token server-side. When unset the export
  // buttons stay hidden — see /api/calendar/* routes which 401 in the
  // same condition. Never inline this into a client component prop.
  const calendarToken = process.env.SWAPCARD_AGENDA_PUBLIC_TOKEN || "";

  return (
    <main className="container container--wide">
      <p style={{ marginBottom: "1rem" }}>
        <a href="/discover" className="muted" style={{ fontSize: "0.9rem" }}>
          ← back to /discover
        </a>
      </p>
      <h1 className="title">event agenda</h1>
      <p className="subtitle">
        the conference schedule — sessions, talks, plenaries — for everyone.
      </p>

      <SignInWithX />

      {!session ? (
        <div className="panel">
          <p>sign in with X to view the agenda.</p>
        </div>
      ) : !card?.swapcardPersonId ? (
        <div className="panel">
          <p>
            link your Swapcard profile first.{" "}
            <a href="/link">go to /link →</a>
          </p>
        </div>
      ) : sessions.length === 0 ? (
        <div className="panel">
          <p style={{ marginTop: 0 }}>
            <strong>no sessions cached.</strong>
          </p>
          <p className="muted" style={{ fontSize: "0.9rem", marginBottom: 0 }}>
            admin needs to run{" "}
            <code>POST /api/swapcard/refresh-event-sessions</code> with a fresh
            Swapcard JWT to populate the cache.
          </p>
        </div>
      ) : (
        <AgendaContent
          sessions={sessions}
          fetchedAt={fetchedAt}
          calendarToken={calendarToken}
        />
      )}
    </main>
  );
}

// ── Server-rendered agenda body ──────────────────────────────────────────────

function AgendaContent({
  sessions,
  fetchedAt,
  calendarToken,
}: {
  sessions: ScrapedSession[];
  fetchedAt: number | null;
  calendarToken: string;
}) {
  const grouped = groupByDay(sessions);
  return (
    <>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "0.75rem",
          marginBottom: "1.5rem",
        }}
      >
        <p
          className="muted"
          style={{ fontSize: "0.85rem", margin: 0 }}
        >
          {sessions.length} sessions across {grouped.length} day
          {grouped.length === 1 ? "" : "s"}
          {fetchedAt !== null ? ` · ${formatCacheAge(fetchedAt)}` : ""}
        </p>
        {calendarToken ? (
          <a
            className="btn ghost"
            style={{ fontSize: "0.85rem", padding: "0.4rem 0.75rem" }}
            href={`/api/calendar/all?t=${encodeURIComponent(calendarToken)}`}
            // The subscription endpoint serves text/calendar; the browser
            // will either download or pop the "Add to Calendar" handler
            // depending on OS associations. The download attribute hints
            // a save-to-disk for browsers that don't auto-handle webcal.
            download="slopcard-agenda.ics"
          >
            📅 subscribe to full agenda
          </a>
        ) : null}
      </div>
      {grouped.map((day) => (
        <DaySection
          key={day.label}
          day={day}
          calendarToken={calendarToken}
        />
      ))}
    </>
  );
}

function DaySection({
  day,
  calendarToken,
}: {
  day: AgendaDayGroup;
  calendarToken: string;
}) {
  // Compute the per-day layout server-side so the page is fully static —
  // no client-side track packing or measurement.
  const laid = layoutDay(day.sessions);
  return (
    <section style={{ marginBottom: "2.5rem" }}>
      <h2
        style={{
          fontSize: "1.1rem",
          fontWeight: 600,
          marginBottom: "0.75rem",
        }}
      >
        {day.label}
      </h2>
      {/* Calendar grid: desktop-only via CSS. The mobile list below is
          hidden at ≥641px so we don't render two copies of the day. */}
      <div className="agenda-calendar">
        <CalendarGrid laid={laid} />
      </div>
      {/* Mobile fallback: the original vertical list. Hidden at ≥641px. */}
      <div className="agenda-list">
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {day.sessions.map((s) => (
            <SessionRow
              key={s.planningId}
              session={s}
              calendarToken={calendarToken}
            />
          ))}
        </div>
      </div>
      {/* Detail cards — anchored from each block via #session-<planningId>.
          Same SessionRow used by the mobile list, so the styling matches. */}
      <details
        style={{
          marginTop: "1rem",
          fontSize: "0.85rem",
        }}
        className="agenda-detail-toggle"
      >
        <summary className="muted" style={{ cursor: "pointer" }}>
          show all {day.sessions.length} detail cards
        </summary>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            marginTop: "0.75rem",
          }}
        >
          {day.sessions.map((s) => (
            <SessionRow
              key={s.planningId}
              session={s}
              calendarToken={calendarToken}
            />
          ))}
        </div>
      </details>
    </section>
  );
}

// ── Calendar timeline grid ───────────────────────────────────────────────────

const SLOT_HEIGHT_REM = 2.4; // height of one 30-min slot
const HOUR_LABEL_WIDTH_REM = 3.5; // gutter for "09:00" labels

function CalendarGrid({ laid }: { laid: LaidOutDay }) {
  const { trackCount, blocks, hours, dayStartMs } = laid;
  // 30-min slot count between dayStart (inclusive) and dayEnd (exclusive).
  // Each slot is SLOT_HEIGHT_REM tall so the grid total is the product.
  const totalSlots = hours.length * 2; // every hour spans two 30-min slots
  const totalHeightRem = totalSlots * SLOT_HEIGHT_REM;
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        gap: "0.5rem",
        background: "var(--paper)",
        border: "1px solid var(--line)",
        borderRadius: "10px",
        padding: "0.75rem",
        boxShadow: "0 2px 8px -4px rgba(46, 31, 18, 0.12)",
      }}
    >
      {/* Hour labels gutter */}
      <div
        style={{
          position: "relative",
          width: `${HOUR_LABEL_WIDTH_REM}rem`,
          flexShrink: 0,
          height: `${totalHeightRem}rem`,
        }}
        aria-hidden="true"
      >
        {hours.map((label, i) => (
          <div
            key={label}
            className="muted"
            style={{
              position: "absolute",
              top: `${i * 2 * SLOT_HEIGHT_REM}rem`,
              right: "0.4rem",
              fontSize: "0.7rem",
              fontVariantNumeric: "tabular-nums",
              transform: "translateY(-0.4rem)",
            }}
          >
            {label}
          </div>
        ))}
      </div>
      {/* Tracks area with gridlines + absolutely-positioned blocks */}
      <div
        style={{
          position: "relative",
          flex: 1,
          height: `${totalHeightRem}rem`,
          minWidth: 0,
        }}
      >
        {/* Hour gridlines (every other 30-min slot). Drawn first so blocks
            paint over them. */}
        {hours.map((_, i) => (
          <div
            key={`hl-${i}`}
            aria-hidden="true"
            style={{
              position: "absolute",
              top: `${i * 2 * SLOT_HEIGHT_REM}rem`,
              left: 0,
              right: 0,
              height: 0,
              borderTop: "1px solid var(--line)",
              opacity: 0.7,
            }}
          />
        ))}
        {/* Half-hour gridlines, fainter */}
        {hours.map((_, i) => (
          <div
            key={`hh-${i}`}
            aria-hidden="true"
            style={{
              position: "absolute",
              top: `${(i * 2 + 1) * SLOT_HEIGHT_REM}rem`,
              left: 0,
              right: 0,
              height: 0,
              borderTop: "1px dashed var(--line)",
              opacity: 0.35,
            }}
          />
        ))}
        {blocks.map((b) => (
          <SessionBlock
            key={b.session.planningId}
            block={b}
            trackCount={trackCount}
            dayStartMs={dayStartMs}
          />
        ))}
      </div>
    </div>
  );
}

// Swapcard's session URL follows the same `/event/<slug>/planning/<id>`
// pattern attendee URLs use with `/person/<id>`. Slug is event-specific.
const SWAPCARD_EVENT_SLUG = process.env.SWAPCARD_EVENT_SLUG || "eag-london";

function swapcardSessionUrl(planningId: string): string {
  return `https://app.swapcard.com/event/${SWAPCARD_EVENT_SLUG}/planning/${encodeURIComponent(planningId)}`;
}

// Mirror of swapcardSessionUrl for person/eventPeopleId. Same slug, same
// encoding scheme. Used to make speaker rows on /agenda click through to the
// Swapcard attendee profile.
function swapcardPersonUrl(eventPeopleId: string): string {
  return `https://app.swapcard.com/event/${SWAPCARD_EVENT_SLUG}/person/${encodeURIComponent(eventPeopleId)}`;
}

function SessionBlock({
  block,
  trackCount,
  dayStartMs,
}: {
  block: LaidOutBlock;
  trackCount: number;
  dayStartMs: number;
}) {
  const beginsMs = new Date(block.session.beginsAt).getTime();
  const endsMs = new Date(block.session.endsAt).getTime();
  const minutesFromStart = (beginsMs - dayStartMs) / 60000;
  const durationMin = Math.max(15, (endsMs - beginsMs) / 60000); // clamp ≥15 so zero-length sessions still render
  const top = (minutesFromStart / 30) * SLOT_HEIGHT_REM;
  const height = (durationMin / 30) * SLOT_HEIGHT_REM;
  const trackWidthPct = 100 / trackCount;
  const leftPct = block.track * trackWidthPct;
  const time = formatTimeRange(block.session.beginsAt, block.session.endsAt);
  const duration = formatDuration(block.session.beginsAt, block.session.endsAt);
  const title = block.session.title || "(untitled session)";
  // Drop the time row in compact blocks — column position already implies the
  // start time and the title needs all the room it can get. Threshold is
  // tuned so 30-min sessions hide the meta row but 1h+ keep it.
  const isCompact = height < SLOT_HEIGHT_REM * 1.5;
  return (
    <a
      href={swapcardSessionUrl(block.session.planningId)}
      target="_blank"
      rel="noopener noreferrer"
      title={`${title} — ${time} (${duration})${block.session.place ? " · " + block.session.place : ""} (opens Swapcard ↗)`}
      className="agenda-block"
      style={{
        position: "absolute",
        top: `${top}rem`,
        height: `${height}rem`,
        left: `calc(${leftPct}% + 0.15rem)`,
        width: `calc(${trackWidthPct}% - 0.3rem)`,
        background: "var(--paper-2)",
        border: "1px solid var(--line-strong)",
        borderLeft: "3px solid var(--coral-strong)",
        borderRadius: "6px",
        padding: "0.3rem 0.45rem",
        overflow: "hidden",
        textDecoration: "none",
        color: "var(--ink)",
        display: "flex",
        flexDirection: "column",
        gap: "0.1rem",
        fontSize: isCompact ? "0.72rem" : "0.78rem",
        lineHeight: 1.2,
      }}
    >
      {/* Title wraps freely now — overflow:hidden on the block clips anything
          past the bottom edge for very long titles in very short blocks. */}
      <div
        style={{
          fontWeight: 600,
          overflowWrap: "anywhere",
          hyphens: "auto",
        }}
      >
        {title}
      </div>
      {!isCompact ? (
        <div
          className="muted"
          style={{
            fontSize: "0.7rem",
            fontVariantNumeric: "tabular-nums",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {time} · {duration}
        </div>
      ) : null}
      {block.session.place && height >= SLOT_HEIGHT_REM * 1.5 ? (
        <div
          className="muted"
          style={{
            fontSize: "0.7rem",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {block.session.place}
        </div>
      ) : null}
    </a>
  );
}

// ── Session detail card (used in mobile list + details panel) ────────────────

function SessionRow({
  session,
  calendarToken,
}: {
  session: ScrapedSession;
  calendarToken: string;
}) {
  const time = formatTimeRange(session.beginsAt, session.endsAt);
  const duration = formatDuration(session.beginsAt, session.endsAt);
  return (
    <article
      id={`session-${session.planningId}`}
      className="panel"
      style={{
        padding: "0.85rem 1rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.4rem",
        scrollMarginTop: "1rem",
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.5rem",
          alignItems: "baseline",
          fontSize: "0.85rem",
        }}
        className="muted"
      >
        <span>{time}</span>
        <span>· {duration}</span>
        {session.place ? <span>· {session.place}</span> : null}
        {session.format && session.format !== "PHYSICAL" ? (
          <span>· {session.format.toLowerCase()}</span>
        ) : null}
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.5rem",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <h3 style={{ fontSize: "1rem", fontWeight: 600, margin: 0 }}>
          {session.title || "(untitled session)"}
        </h3>
        {calendarToken ? (
          <a
            className="muted"
            href={`/api/calendar/event/${encodeURIComponent(session.planningId)}?t=${encodeURIComponent(calendarToken)}`}
            download={`slopcard-${session.planningId}.ics`}
            style={{ fontSize: "0.8rem", whiteSpace: "nowrap" }}
          >
            📅 add to calendar
          </a>
        ) : null}
      </div>
      {session.categories.length > 0 ? (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.35rem",
            marginTop: "0.15rem",
          }}
        >
          {session.categories.map((c) => (
            <span
              key={c.id}
              className="muted"
              style={{
                fontSize: "0.75rem",
                padding: "0.1rem 0.5rem",
                border: "1px solid var(--border, #ddd)",
                borderRadius: "999px",
              }}
            >
              {c.name}
            </span>
          ))}
        </div>
      ) : null}
      {session.speakers.length > 0 ? (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: "0.4rem 0 0 0",
            display: "flex",
            flexDirection: "column",
            gap: "0.25rem",
          }}
        >
          {session.speakers.map((sp) => (
            <li
              key={sp.eventPeopleId}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                fontSize: "0.85rem",
              }}
            >
              <a
                href={swapcardPersonUrl(sp.eventPeopleId)}
                target="_blank"
                rel="noopener noreferrer"
                title={`open ${sp.firstName} ${sp.lastName} on Swapcard ↗`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  color: "var(--ink)",
                  textDecoration: "none",
                  flex: 1,
                  minWidth: 0,
                }}
              >
                <Avatar
                  personId={null}
                  eventPeopleId={sp.eventPeopleId}
                  hasPhoto={!!sp.photoUrl}
                  firstName={sp.firstName}
                  lastName={sp.lastName}
                  size={32}
                />
                <span style={{ minWidth: 0 }}>
                  {sp.firstName} {sp.lastName}
                  {sp.organization ? (
                    <span className="muted"> · {sp.organization}</span>
                  ) : null}
                </span>
              </a>
              {/* Star sits OUTSIDE the link anchor so clicks don't navigate.
                  Uses eventPeopleId as the bookmark key — shares the
                  `slopcard:saved_person_ids` localStorage set with /people
                  and /discover so a star here shows up everywhere. */}
              <BookmarkStar personId={sp.eventPeopleId} />
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

// ── Day-grouping + layout helpers ────────────────────────────────────────────

interface AgendaDayGroup {
  label: string;
  sessions: ScrapedSession[];
}

interface LaidOutBlock {
  session: ScrapedSession;
  track: number; // 0-indexed track assignment from greedy interval coloring
}

interface LaidOutDay {
  trackCount: number;
  blocks: LaidOutBlock[];
  hours: string[]; // hour labels like "09:00", "10:00", ...
  dayStartMs: number; // ms-since-epoch of the first labelled hour
}

// Group sessions into calendar days. Uses toDateString() on the parsed
// beginsAt so sessions starting at 23:30 land on the same day as the rest
// of that evening's track (we don't shift by tz beyond what JS does locally,
// which is fine: Swapcard returns ISO strings with offsets so the math is
// stable across servers).
function groupByDay(sessions: ScrapedSession[]): AgendaDayGroup[] {
  const groups = new Map<string, ScrapedSession[]>();
  for (const s of sessions) {
    const d = new Date(s.beginsAt);
    const key = isNaN(d.getTime()) ? "unknown" : d.toDateString();
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  return Array.from(groups.entries()).map(([label, sessions]) => ({
    label: label === "unknown" ? "unknown day" : label,
    sessions,
  }));
}

// Greedy interval-graph coloring. Sort by start, then assign each session to
// the leftmost track whose previous occupant has ended by the time this one
// starts. This is the textbook "minimum chromatic number for interval
// graphs" algorithm and produces the optimal track count.
//
// Also computes the day's bounds (min start rounded down to the hour, max
// end rounded up) so the timeline grid only renders the hours that actually
// contain sessions.
function layoutDay(sessions: ScrapedSession[]): LaidOutDay {
  const valid = sessions.filter((s) => {
    const a = new Date(s.beginsAt).getTime();
    const b = new Date(s.endsAt).getTime();
    return !isNaN(a) && !isNaN(b);
  });
  if (valid.length === 0) {
    return { trackCount: 1, blocks: [], hours: [], dayStartMs: 0 };
  }
  // Stable sort: by start, then by end so equal-start sessions land on
  // adjacent tracks deterministically. Secondary by planningId so the
  // render order matches the DB ordering.
  const sorted = [...valid].sort((a, b) => {
    const aBegin = new Date(a.beginsAt).getTime();
    const bBegin = new Date(b.beginsAt).getTime();
    if (aBegin !== bBegin) return aBegin - bBegin;
    const aEnd = new Date(a.endsAt).getTime();
    const bEnd = new Date(b.endsAt).getTime();
    if (aEnd !== bEnd) return aEnd - bEnd;
    return a.planningId < b.planningId ? -1 : 1;
  });

  // trackEnds[i] = end-ms of the last session assigned to track i. We pick
  // the leftmost track whose end ≤ current start; failing that we open a
  // new track.
  const trackEnds: number[] = [];
  const blocks: LaidOutBlock[] = [];
  for (const s of sorted) {
    const beginMs = new Date(s.beginsAt).getTime();
    const endMs = new Date(s.endsAt).getTime();
    let placed = -1;
    for (let t = 0; t < trackEnds.length; t += 1) {
      if (trackEnds[t] <= beginMs) {
        placed = t;
        break;
      }
    }
    if (placed === -1) {
      placed = trackEnds.length;
      trackEnds.push(endMs);
    } else {
      trackEnds[placed] = endMs;
    }
    blocks.push({ session: s, track: placed });
  }

  // Day bounds: min(begin) rounded down to the hour, max(end) rounded up.
  let minBegin = Number.POSITIVE_INFINITY;
  let maxEnd = Number.NEGATIVE_INFINITY;
  for (const s of sorted) {
    const a = new Date(s.beginsAt).getTime();
    const b = new Date(s.endsAt).getTime();
    if (a < minBegin) minBegin = a;
    if (b > maxEnd) maxEnd = b;
  }
  const dayStart = floorToHour(minBegin);
  const dayEnd = ceilToHour(maxEnd);
  const hours = enumerateHourLabels(dayStart, dayEnd);

  return {
    trackCount: Math.max(1, trackEnds.length),
    blocks,
    hours,
    dayStartMs: dayStart,
  };
}

function floorToHour(ms: number): number {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

function ceilToHour(ms: number): number {
  const d = new Date(ms);
  if (d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0) {
    return d.getTime();
  }
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return d.getTime();
}

// Walk hour-by-hour from dayStart to dayEnd producing "HH:00" labels in the
// viewer's local tz. We deliberately use local tz instead of forcing UTC —
// agendas are shown for the conference timezone the page was loaded in.
function enumerateHourLabels(startMs: number, endMs: number): string[] {
  const labels: string[] = [];
  for (let t = startMs; t < endMs; t += 3600_000) {
    const d = new Date(t);
    const hh = String(d.getHours()).padStart(2, "0");
    labels.push(`${hh}:00`);
  }
  // Always render at least one row so empty days don't collapse to zero.
  if (labels.length === 0) labels.push("00:00");
  return labels;
}

// ── Time / duration formatting ───────────────────────────────────────────────

function formatTimeRange(beginsAt: string, endsAt: string): string {
  const a = new Date(beginsAt);
  const b = new Date(endsAt);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return "";
  const fmt = (d: Date) =>
    d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  return `${fmt(a)} – ${fmt(b)}`;
}

// Human-readable session duration: "30m", "1h", "1h 30m", "2h 15m". Sessions
// that don't land on a 5-min boundary (rare, but Swapcard does emit odd
// durations) are rounded to nearest 5 min so the display stays tidy.
function formatDuration(beginsAt: string, endsAt: string): string {
  const a = new Date(beginsAt).getTime();
  const b = new Date(endsAt).getTime();
  if (isNaN(a) || isNaN(b) || b <= a) return "";
  const totalMin = Math.round((b - a) / 60000 / 5) * 5;
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin - h * 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function formatCacheAge(fetchedAt: number): string {
  const ageMs = Date.now() - fetchedAt;
  const ageHours = Math.floor(ageMs / 3_600_000);
  if (ageHours < 1) {
    const ageMin = Math.max(1, Math.floor(ageMs / 60_000));
    return `cached ${ageMin}m ago`;
  }
  return `cached ${ageHours}h ago`;
}
