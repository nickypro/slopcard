"use client";

import { useCallback, useEffect, useState } from "react";

// Same storage shape as SavedNotes — a flat map keyed by personId OR
// eventPeopleId (whichever the rest of the bookmark plumbing uses for this
// row). Value is just `true`; we don't need a timestamp here, and we prune
// falsy keys from the map on toggle-off so it doesn't bloat.
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

function writeMet(id: string, met: boolean): void {
  if (typeof window === "undefined") return;
  const all = readAllMet();
  if (met) {
    all[id] = true;
  } else {
    delete all[id];
  }
  try {
    localStorage.setItem(MET_STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* quota / private mode — silently drop */
  }
}

interface Props {
  id: string | null;
}

// Per-bookmark "met" checkbox. One click marks the person met; click again
// to unmark. Visual: gray circle when unmet, green ✓ when met. Same storage
// pattern + cross-tab sync as SavedNotes / BookmarkStar so the state follows
// the bookmark wherever it appears.
export default function MetToggle({ id }: Props) {
  const [met, setMet] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!id) {
      setHydrated(true);
      return;
    }
    setMet(readAllMet()[id] === true);
    setHydrated(true);
  }, [id]);

  // Cross-tab/cross-page sync. When the user toggles met on another tab,
  // reflect that here without waiting for the next render.
  useEffect(() => {
    if (!id) return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== MET_STORAGE_KEY) return;
      setMet(readAllMet()[id] === true);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [id]);

  const toggle = useCallback(() => {
    if (!id) return;
    const next = !met;
    setMet(next);
    writeMet(id, next);
  }, [id, met]);

  if (!id || !hydrated) return null;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={met ? "mark as not met" : "mark as met"}
      title={met ? "met — click to unmark" : "mark as met"}
      style={{
        background: "transparent",
        border: "none",
        cursor: "pointer",
        fontSize: "1.05rem",
        lineHeight: 1,
        padding: "0.25rem 0.4rem",
        color: met ? "var(--ok, #2e7d32)" : "rgba(0,0,0,0.25)",
        minHeight: "2.4rem",
        minWidth: "2.4rem",
      }}
    >
      {met ? "✓" : "○"}
    </button>
  );
}
