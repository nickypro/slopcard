"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Avatar from "@/components/Avatar";
import BookmarkStar from "@/components/BookmarkStar";
import MetToggle from "@/components/MetToggle";
import SavedNotes from "@/components/SavedNotes";
import type { SwapcardAttendeeSearchResult } from "@/lib/db";
import { isSwapcardProfileUrl } from "@/lib/swapcard/parse-url";

const PAGE_SIZE = 50;

type SortMode = "alphabetical" | "closeness";

export interface PeopleInfiniteListProps {
  initialResults: SwapcardAttendeeSearchResult[];
  initialTotal: number;
  query: string;
  causeArea: string;
  sort: SortMode;
}

// Stable id used as the React key.
function rowId(r: SwapcardAttendeeSearchResult): string {
  return r.personId ?? r.eventPeopleId ?? "";
}

// Hydrates from a server-rendered first page (so /people?q=... still SSRs
// and back-button feels right) then takes over via IntersectionObserver.
// The sort order — alphabetical or vector-closeness — is determined entirely
// server-side and the client just renders whatever order the API returned.
// Earlier versions did a per-page closeness re-rank in the client, which made
// every scroll batch fall back to alphabetical-within-batch (since the
// server still streamed alphabetical and the rerank only touched one page at
// a time). The page-wide global cosine sort lives in the server now.
export default function PeopleInfiniteList({
  initialResults,
  initialTotal,
  query,
  causeArea,
  sort,
}: PeopleInfiniteListProps) {
  const [results, setResults] = useState<SwapcardAttendeeSearchResult[]>(
    initialResults
  );
  const [total, setTotal] = useState<number>(initialTotal);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Reset state when the route inputs change. The page re-renders with new
  // initial props but state hangs around otherwise.
  useEffect(() => {
    setResults(initialResults);
    setTotal(initialTotal);
    setError(null);
  }, [initialResults, initialTotal, query, causeArea, sort]);

  const offset = results.length;
  const hasMore = offset < total;

  // Fetch the next page from /api/swapcard/people-page. Bails if already
  // loading or if we've already rendered everything.
  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/swapcard/people-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          q: query,
          c: causeArea,
          sort,
          offset,
          limit: PAGE_SIZE,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        results: SwapcardAttendeeSearchResult[];
        total: number;
      };
      setResults((prev) => [...prev, ...body.results]);
      setTotal(body.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [loading, hasMore, query, causeArea, sort, offset]);

  // IntersectionObserver: when the sentinel scrolls into view, fire loadMore.
  // Re-binds whenever the callback identity changes so the closure stays
  // current.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) loadMore();
        }
      },
      { rootMargin: "200px 0px" }
    );
    io.observe(node);
    return () => io.disconnect();
  }, [loadMore]);

  const sorted = results;

  return (
    <>
      {sorted.length === 0 ? (
        <div className="panel">
          <p>
            {query
              ? "nothing matched. try a shorter query or a different field."
              : "no attendees in the cache yet."}
          </p>
        </div>
      ) : (
        <div className="panel" style={{ padding: 0 }}>
          {sorted.map((r, i) => (
            <PersonRow
              key={`${rowId(r)}-${i}`}
              row={r}
              isLast={i === sorted.length - 1}
            />
          ))}
        </div>
      )}

      {/* Sentinel + status line. The sentinel sits at the bottom of the list
          so the IntersectionObserver triggers when the user scrolls into it.
          We keep it in the DOM even when !hasMore so layout stays stable. */}
      <div
        ref={sentinelRef}
        style={{
          minHeight: "2rem",
          marginTop: "1rem",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        {loading ? (
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            loading…
          </span>
        ) : error ? (
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            error: {error}
          </span>
        ) : !hasMore && total > 0 ? (
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            no more results
          </span>
        ) : null}
      </div>
    </>
  );
}

function PersonRow({
  row,
  isLast,
}: {
  row: SwapcardAttendeeSearchResult;
  isLast: boolean;
}) {
  const name = [row.firstName, row.lastName].filter(Boolean).join(" ") || "—";
  const meta = [row.jobTitle, row.company, row.country]
    .filter(Boolean)
    .join(" · ");
  // Same defense as the SSR PersonRow — re-validate the sheet URL before
  // putting it in the DOM.
  const safeHref = isSwapcardProfileUrl(row.swapcardUrl)
    ? row.swapcardUrl
    : null;

  // Outer box gets the row separator + padding; inner flex aligns the
  // avatar/name/star. SavedNotes hangs below (renders nothing when empty in
  // compact mode), preserving existing browse density.
  const outerStyle: React.CSSProperties = {
    borderBottom: isLast ? "none" : "1px solid rgba(0,0,0,0.06)",
    padding: "0 1rem",
  };
  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
  };
  const linkStyle: React.CSSProperties = {
    display: "flex",
    gap: "0.85rem",
    padding: "0.85rem 0",
    alignItems: "center",
    color: "var(--ink)",
    textDecoration: "none",
    flex: 1,
    minWidth: 0,
  };
  const id = row.personId ?? row.eventPeopleId;

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
        {meta ? (
          <div
            className="muted"
            style={{ fontSize: "0.85rem", marginTop: "0.1rem" }}
          >
            {meta}
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

  return (
    <div style={outerStyle}>
      <div style={rowStyle}>
        {safeHref ? (
          <a
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer"
            style={linkStyle}
          >
            {body}
          </a>
        ) : (
          <div style={linkStyle}>{body}</div>
        )}
        <div
          style={{
            paddingLeft: "0.5rem",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
          }}
        >
          <MetToggle id={id} />
          <BookmarkStar personId={id} />
        </div>
      </div>
      {/* compact mode: renders nothing when the user has no note for this
          person, so empty browse rows stay tight. Existing notes appear as
          an inline textarea — same component, same storage as /saved. */}
      <div style={{ paddingBottom: "0.5rem" }}>
        <SavedNotes id={id} mode="compact" />
      </div>
    </div>
  );
}
