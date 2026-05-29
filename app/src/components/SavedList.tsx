"use client";

import { useEffect, useMemo, useState } from "react";
import Avatar from "@/components/Avatar";
import BookmarkStar from "@/components/BookmarkStar";
import MetToggle from "@/components/MetToggle";
import SavedNotes from "@/components/SavedNotes";
import { serializeCsv } from "@/lib/csv";
import { isSwapcardProfileUrl } from "@/lib/swapcard/parse-url";

const NOTES_STORAGE_KEY = "slopcard:saved_notes";
const MET_STORAGE_KEY = "slopcard:saved_met";

function readAllMet(): Record<string, true> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(MET_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, true> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof k === "string" && v === true) out[k] = true;
      }
      return out;
    }
  } catch {
    /* malformed / unavailable */
  }
  return {};
}

function readAllNotes(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(NOTES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof k === "string" && typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    /* malformed / unavailable */
  }
  return {};
}

// Same key used by BookmarkStar + DiscoverView. Lifting this into a shared
// constant feels right but would need a second module; the duplication is
// load-bearing because /saved is the only page that READS the full list.
const SAVED_STORAGE_KEY = "slopcard:saved_person_ids";

interface SavedItem {
  personId: string | null;
  eventPeopleId: string | null;
  firstName: string;
  lastName: string;
  jobTitle: string;
  company: string;
  country: string;
  hasPhoto: boolean;
  swapcardUrl: string;
  overlapWithMe: number;
}

interface SummaryResponse {
  ok: boolean;
  items: SavedItem[];
  myHasSlots: boolean;
  error?: string;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "empty-saves" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: SavedItem[]; myHasSlots: boolean };

function readSavedIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(SAVED_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    /* malformed / unavailable */
  }
  return [];
}

// The /saved page's client core. POSTs the user's bookmarked IDs to the
// summary endpoint, sorts by overlap-then-alphabet, and renders the rows
// with a free client-side filter input on top.
export default function SavedList() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [filter, setFilter] = useState("");
  // Saved IDs from localStorage — kept in state so the BookmarkStar's
  // "storage" event can trigger a re-fetch when the user unsaves a row.
  const [savedIds, setSavedIds] = useState<string[]>([]);
  // Notes map (id → text) mirrored from localStorage so the filter haystack
  // can include them and the CSV export reads from current state. Kept in
  // sync with the same polling interval as savedIds (1s) plus storage events.
  const [notes, setNotes] = useState<Record<string, string>>({});
  // Met map (id → true). Same sync model as notes — drives the "unmet only"
  // toggle below and the visual dim on rows that have been ticked.
  const [met, setMet] = useState<Record<string, true>>({});
  const [unmetOnly, setUnmetOnly] = useState(false);

  // Re-load both the saved set AND the summary whenever the storage key
  // changes. Wrapping the fetch in an async IIFE keeps useEffect's return
  // type clean.
  useEffect(() => {
    const ids = readSavedIds();
    setSavedIds(ids);
    if (ids.length === 0) {
      setState({ kind: "empty-saves" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      try {
        const res = await fetch("/api/swapcard/saved-summary", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ personIds: ids }),
        });
        const data = (await res.json().catch(() => ({}))) as SummaryResponse;
        if (cancelled) return;
        if (!res.ok || !data.ok) {
          setState({
            kind: "error",
            message: data.error ?? `failed to load (${res.status})`,
          });
          return;
        }
        setState({
          kind: "ready",
          items: data.items ?? [],
          myHasSlots: !!data.myHasSlots,
        });
      } catch (err) {
        if (cancelled) return;
        setState({ kind: "error", message: (err as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Listen for cross-tab/cross-page bookmark toggles. When the user unsaves
  // a row via its star, we drop it from the rendered list optimistically
  // without re-fetching. Same storage handler covers note edits so the
  // filter haystack stays current after typing in a SavedNotes textarea.
  useEffect(() => {
    setNotes(readAllNotes()); // hydrate on mount
    setMet(readAllMet());
    const onStorage = (e: StorageEvent) => {
      if (e.key === SAVED_STORAGE_KEY) {
        const ids = readSavedIds();
        setSavedIds(ids);
        setState((prev) => {
          if (prev.kind !== "ready") return prev;
          const allowed = new Set(ids);
          return {
            ...prev,
            items: prev.items.filter(
              (it) =>
                (it.personId && allowed.has(it.personId)) ||
                (it.eventPeopleId && allowed.has(it.eventPeopleId))
            ),
          };
        });
        if (ids.length === 0) setState({ kind: "empty-saves" });
      } else if (e.key === NOTES_STORAGE_KEY) {
        setNotes(readAllNotes());
      } else if (e.key === MET_STORAGE_KEY) {
        setMet(readAllMet());
      }
    };
    window.addEventListener("storage", onStorage);
    // Polling fallback for same-tab toggles (storage events don't fire in
    // the originating tab). Cheap and bounded — only runs while the page
    // is open, and just compares lengths/content cheaply.
    const interval = window.setInterval(() => {
      const ids = readSavedIds();
      setSavedIds((prev) => {
        if (
          prev.length === ids.length &&
          prev.every((id, i) => id === ids[i])
        ) {
          return prev;
        }
        return ids;
      });
      const cur = readAllNotes();
      setNotes((prev) => {
        const prevKeys = Object.keys(prev);
        const curKeys = Object.keys(cur);
        if (prevKeys.length === curKeys.length) {
          let same = true;
          for (const k of curKeys) {
            if (prev[k] !== cur[k]) {
              same = false;
              break;
            }
          }
          if (same) return prev;
        }
        return cur;
      });
      const curMet = readAllMet();
      setMet((prev) => {
        const prevKeys = Object.keys(prev);
        const curKeys = Object.keys(curMet);
        if (prevKeys.length === curKeys.length) {
          let same = true;
          for (const k of curKeys) {
            if (prev[k] !== curMet[k]) {
              same = false;
              break;
            }
          }
          if (same) return prev;
        }
        return curMet;
      });
    }, 1000);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.clearInterval(interval);
    };
  }, []);

  // Drop items that have been unstarred since the fetch. This keeps the
  // rendered list in lockstep with the saved-set without a re-fetch.
  const sortedItems = useMemo(() => {
    if (state.kind !== "ready") return [];
    const allowed = new Set(savedIds);
    const live = state.items.filter(
      (it) =>
        (it.personId && allowed.has(it.personId)) ||
        (it.eventPeopleId && allowed.has(it.eventPeopleId))
    );
    return [...live].sort((a, b) => {
      if (b.overlapWithMe !== a.overlapWithMe) {
        return b.overlapWithMe - a.overlapWithMe;
      }
      const al = a.lastName.toLowerCase();
      const bl = b.lastName.toLowerCase();
      if (al !== bl) return al < bl ? -1 : 1;
      return a.firstName.toLowerCase() < b.firstName.toLowerCase() ? -1 : 1;
    });
  }, [state, savedIds]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return sortedItems.filter((it) => {
      const id = it.personId ?? it.eventPeopleId ?? "";
      if (unmetOnly && met[id] === true) return false;
      if (!q) return true;
      const note = notes[id] ?? "";
      // Notes join the haystack so "lunch" / "agent eval" / "follow up about
      // X" recover the right person without scanning the list by eye. Same
      // lowercase + substring rule as the other fields.
      const hay = [
        it.firstName,
        it.lastName,
        it.jobTitle,
        it.company,
        it.country,
        note,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [sortedItems, filter, notes, met, unmetOnly]);

  // Count met for the stats line; cheap O(items) walk.
  const metCount = useMemo(() => {
    let n = 0;
    for (const it of sortedItems) {
      const id = it.personId ?? it.eventPeopleId ?? "";
      if (met[id] === true) n += 1;
    }
    return n;
  }, [sortedItems, met]);

  if (state.kind === "loading") {
    return (
      <div className="panel">
        <p className="muted">loading your saved attendees…</p>
      </div>
    );
  }

  if (state.kind === "empty-saves") {
    return (
      <div className="panel">
        <p>
          no saved attendees yet. star someone on{" "}
          <a href="/discover">/discover</a> or <a href="/people">/people</a>,
          then come back.
        </p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="panel">
        <p className="error">couldn&apos;t load saved attendees: {state.message}</p>
      </div>
    );
  }

  // Some saves resolved to no row (likely attendees dropped from the latest
  // sheet ingest). Surface the count so the user knows the list isn't lying
  // to them.
  const unresolvedCount = Math.max(0, savedIds.length - sortedItems.length);

  return (
    <>
      {!state.myHasSlots ? (
        <p
          className="muted"
          style={{ fontSize: "0.85rem", marginBottom: "0.75rem" }}
        >
          (your slot data not cached — admin needs to refresh /api/swapcard/refresh-slots)
        </p>
      ) : null}

      <div
        className="panel"
        style={{
          display: "flex",
          gap: "0.5rem",
          marginBottom: "1rem",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter by name / company / role / note…"
          style={{
            flex: 1,
            minWidth: "12rem",
            padding: "0.55rem 0.75rem",
            fontSize: "0.95rem",
          }}
        />
        {filter ? (
          <button
            type="button"
            className="btn ghost"
            onClick={() => setFilter("")}
          >
            clear
          </button>
        ) : null}
        <label
          className="muted"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.3rem",
            fontSize: "0.85rem",
            cursor: "pointer",
            userSelect: "none",
          }}
          title="hide attendees you've already met"
        >
          <input
            type="checkbox"
            checked={unmetOnly}
            onChange={(e) => setUnmetOnly(e.target.checked)}
          />
          unmet only
        </label>
        <button
          type="button"
          className="btn ghost"
          onClick={() => exportSavedCsv(sortedItems)}
          title="download a CSV of your saved attendees + notes"
        >
          export CSV ↓
        </button>
      </div>

      <div
        className="muted"
        style={{ fontSize: "0.85rem", marginBottom: "0.75rem" }}
      >
        {sortedItems.length} saved
        {metCount > 0 ? ` · ${metCount} met` : ""}
        {filter
          ? ` · ${filtered.length} matching "${filter}"`
          : unmetOnly
            ? ` · ${filtered.length} unmet`
            : ""}
        {unresolvedCount > 0
          ? ` · ${unresolvedCount} not in current attendee cache`
          : ""}
      </div>

      {filtered.length === 0 ? (
        <div className="panel">
          <p>
            {filter
              ? "nothing matched. try a shorter query."
              : "all saved attendees are missing from the cache — try re-ingesting."}
          </p>
        </div>
      ) : (
        <div className="panel" style={{ padding: 0 }}>
          {filtered.map((it, i) => {
            const id = it.personId ?? it.eventPeopleId ?? "";
            return (
              <SavedRow
                key={`${id || i}`}
                row={it}
                isLast={i === filtered.length - 1}
                myHasSlots={state.myHasSlots}
                isMet={id ? met[id] === true : false}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

function SavedRow({
  row,
  isLast,
  myHasSlots,
  isMet,
}: {
  row: SavedItem;
  isLast: boolean;
  myHasSlots: boolean;
  isMet: boolean;
}) {
  const name = [row.firstName, row.lastName].filter(Boolean).join(" ") || "—";
  const meta = [row.jobTitle, row.company, row.country]
    .filter(Boolean)
    .join(" · ");
  // sheet-supplied URL — same defense as /people. Reject anything that
  // doesn't parse as a Swapcard profile link rather than putting raw user
  // input into the DOM.
  const safeHref = isSwapcardProfileUrl(row.swapcardUrl)
    ? row.swapcardUrl
    : null;

  // Three states for the overlap line:
  //   - we don't have my slots → render nothing here (top-of-page hint covers it)
  //   - we have my slots and >0 overlap → "· N free slots overlap with you"
  //   - we have my slots and 0 overlap → "· no overlap"
  let overlapLine: string | null = null;
  if (myHasSlots) {
    if (row.overlapWithMe > 0) {
      overlapLine =
        row.overlapWithMe === 1
          ? "· 1 free slot overlap with you"
          : `· ${row.overlapWithMe} free slots overlap with you`;
    } else {
      overlapLine = "· no overlap";
    }
  }

  const linkStyle: React.CSSProperties = {
    display: "flex",
    gap: "0.85rem",
    padding: "0.85rem 1rem",
    alignItems: "center",
    color: "var(--ink)",
    textDecoration: "none",
    flex: 1,
    minWidth: 0,
  };

  const body = (
    <>
      <Avatar
        personId={row.personId}
        eventPeopleId={row.eventPeopleId}
        hasPhoto={row.hasPhoto}
        firstName={row.firstName}
        lastName={row.lastName}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500 }}>{name}</div>
        {meta || overlapLine ? (
          <div
            className="muted"
            style={{ fontSize: "0.85rem", marginTop: "0.1rem" }}
          >
            {meta}
            {meta && overlapLine ? " " : ""}
            {overlapLine ? (
              <span
                style={{
                  color:
                    row.overlapWithMe > 0
                      ? "var(--ok, #2e7d32)"
                      : "inherit",
                }}
              >
                {overlapLine}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {safeHref ? (
        <span
          className="muted"
          style={{ fontSize: "0.85rem", flexShrink: 0 }}
        >
          open →
        </span>
      ) : null}
    </>
  );

  // Wrap the row + notes in a column so the textarea sits below the row body
  // when expanded, without breaking the flex alignment of avatar / name / star.
  // Met rows fade slightly so the unmet list pops out visually — the explicit
  // ✓ icon does the heavier signaling.
  const outerStyle: React.CSSProperties = {
    borderBottom: isLast ? "none" : "1px solid rgba(0,0,0,0.06)",
    padding: "0.85rem 1rem",
    opacity: isMet ? 0.55 : 1,
  };
  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  };
  // Inline padding got moved to outer; linkStyle no longer needs its own.
  const innerLinkStyle: React.CSSProperties = {
    ...linkStyle,
    padding: 0,
  };

  return (
    <div style={outerStyle}>
      <div style={rowStyle}>
        {safeHref ? (
          <a
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer"
            style={innerLinkStyle}
          >
            {body}
          </a>
        ) : (
          <div style={innerLinkStyle}>{body}</div>
        )}
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
          <MetToggle id={row.personId ?? row.eventPeopleId} />
          <BookmarkStar personId={row.personId ?? row.eventPeopleId} />
        </div>
      </div>
      <SavedNotes id={row.personId ?? row.eventPeopleId} />
    </div>
  );
}

// Build a CSV blob from the saved items + their localStorage notes and
// trigger a download. All client-side — no server round-trip, no auth
// concern. Notes live only in the user's browser anyway; pulling them out
// for backup / sharing is the obvious need at conference end.
function exportSavedCsv(items: SavedItem[]): void {
  if (typeof window === "undefined") return;
  const notes = readAllNotes();
  const metMap = readAllMet();
  // Join the per-row note + met flag alongside the SavedItem fields, then
  // hand the whole shape to serializeCsv. Column order matches what a user
  // scans. Met → "yes"/"" so the CSV stays human-skimmable in Excel.
  const rows = items.map((it) => {
    const id = it.personId ?? it.eventPeopleId ?? "";
    return {
      firstName: it.firstName,
      lastName: it.lastName,
      jobTitle: it.jobTitle,
      company: it.company,
      country: it.country,
      swapcardUrl: it.swapcardUrl,
      overlapSlots: it.overlapWithMe,
      met: metMap[id] === true ? "yes" : "",
      note: notes[id] ?? "",
      personId: it.personId ?? "",
      eventPeopleId: it.eventPeopleId ?? "",
    };
  });
  const csv = serializeCsv(rows, [
    "firstName",
    "lastName",
    "jobTitle",
    "company",
    "country",
    "swapcardUrl",
    "overlapSlots",
    "met",
    "note",
    "personId",
    "eventPeopleId",
  ]);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const today = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = url;
  a.download = `slopcard-saved-${today}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a tick to start the download before reclaiming the
  // blob URL — Safari has been known to abort if you revoke too eagerly.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
