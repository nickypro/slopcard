"use client";

import { useEffect, useState } from "react";

// Shared localStorage key — read/written by DiscoverView too, so a star
// toggled on /people shows up immediately on /discover (and vice versa).
const SAVED_STORAGE_KEY = "slopcard:saved_person_ids";

function readSaved(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(SAVED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((x) => typeof x === "string"));
    }
  } catch {
    /* malformed / unavailable */
  }
  return new Set();
}

function writeSaved(s: Set<string>): void {
  try {
    localStorage.setItem(SAVED_STORAGE_KEY, JSON.stringify([...s]));
  } catch {
    /* unavailable */
  }
}

// A tiny client component that flips a saved-flag in localStorage. Used on
// every row of /people so the same bookmark UX from /discover carries over.
// Doesn't render anything when personId is null (e.g. stub attendees).
export default function BookmarkStar({
  personId,
  size = "0.95rem",
}: {
  personId: string | null;
  size?: string;
}) {
  const [saved, setSaved] = useState(false);

  // Reads localStorage AFTER mount to avoid SSR hydration mismatch. Also
  // listens to `storage` events so a toggle in another tab / on another page
  // reflects here without a manual refresh.
  useEffect(() => {
    if (!personId) return;
    setSaved(readSaved().has(personId));
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SAVED_STORAGE_KEY) return;
      setSaved(readSaved().has(personId));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [personId]);

  if (!personId) return null;

  return (
    <button
      type="button"
      onClick={(e) => {
        // Stop the click from triggering the row's anchor navigation when
        // the star is inside an <a>.
        e.preventDefault();
        e.stopPropagation();
        const next = readSaved();
        if (next.has(personId)) next.delete(personId);
        else next.add(personId);
        writeSaved(next);
        setSaved(next.has(personId));
      }}
      aria-label={saved ? "unsave this person" : "save this person"}
      title={saved ? "unsave" : "save for later"}
      style={{
        background: "transparent",
        border: "none",
        cursor: "pointer",
        fontSize: size,
        lineHeight: 1,
        padding: "0.25rem 0.4rem",
        color: saved ? "var(--gold, #d4a93a)" : "rgba(0,0,0,0.25)",
        minHeight: "2.4rem",
        minWidth: "2.4rem",
        flexShrink: 0,
      }}
    >
      {saved ? "★" : "☆"}
    </button>
  );
}
