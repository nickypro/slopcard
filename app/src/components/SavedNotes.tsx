"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Same-shaped localStorage key as `slopcard:saved_person_ids` — kept in sync
// with BookmarkStar so notes survive across page navs and cross-tab edits.
// Map shape: { [personOrEventPeopleId]: noteText }. Empty strings get pruned
// so the map doesn't bloat with empty entries from accidental edits.
const NOTES_STORAGE_KEY = "slopcard:saved_notes";

function readAll(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(NOTES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // Defensive: drop non-string values that might have crept in.
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

function writeNote(id: string, text: string): void {
  if (typeof window === "undefined") return;
  const all = readAll();
  if (text.length === 0) {
    delete all[id];
  } else {
    all[id] = text;
  }
  try {
    localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* quota / private mode — silently drop the write */
  }
}

interface Props {
  // Stable id used as the localStorage key. /saved passes personId (preferred)
  // or eventPeopleId — matches the bookmark star's keying scheme.
  id: string | null;
  // "full" (default, /saved): renders the "+ note" chip when empty so the
  // user can add a note any time. "compact" (/people, /discover): renders
  // NOTHING when empty so the browse surface doesn't fill with chips; the
  // existing note appears as a clickable preview that expands on click. Same
  // localStorage key + sync behavior in both modes.
  mode?: "full" | "compact";
}

// Per-bookmark notes textarea. Hidden by default with a "+ note" CTA when
// empty (in mode="full"); auto-expands once there's content. Saves to
// localStorage on every edit (debounced 400ms) AND on blur. Conference flow:
// owner taps the chip, types "met at lunch, follow up on agent eval", taps
// away — context preserved client-side, no server round-trip, no auth concern.
export default function SavedNotes({ id, mode = "full" }: Props) {
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(false);
  // Tracks whether we've finished the initial localStorage hydration. Avoids
  // a flash of empty -> populated for users with existing notes.
  const [hydrated, setHydrated] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!id) {
      setHydrated(true);
      return;
    }
    const all = readAll();
    const existing = all[id] ?? "";
    setText(existing);
    if (existing.length > 0) setExpanded(true);
    setHydrated(true);
  }, [id]);

  // Cross-tab/cross-page sync. When notes for the same id change in another
  // tab, reflect that here so the user doesn't see stale text.
  useEffect(() => {
    if (!id) return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== NOTES_STORAGE_KEY) return;
      const all = readAll();
      const next = all[id] ?? "";
      // Only mirror if we're not the originator of the edit — checking the
      // local taRef's focus state is a good-enough heuristic to avoid stomping
      // the user's in-progress edit.
      if (document.activeElement !== taRef.current) {
        setText(next);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [id]);

  // Debounced persistence. 400ms is short enough to feel "live" and long
  // enough that each keystroke doesn't hit localStorage individually.
  const scheduleSave = useCallback(
    (next: string) => {
      if (!id) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        writeNote(id, next);
      }, 400);
    },
    [id]
  );

  // Flush any pending debounced write on unmount so a fast page-nav after
  // typing doesn't drop the last keystroke window.
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        if (id) writeNote(id, text);
      }
    };
  }, [id, text]);

  // Without an id we can't key the storage, so degrade gracefully — render
  // nothing rather than a useless inputthat'd discard its value on every nav.
  if (!id || !hydrated) return null;

  if (!expanded && text.length === 0) {
    // Compact mode (browse surfaces): no "+ note" chip when empty. Owner
    // adds notes from /saved; here we only surface existing context.
    if (mode === "compact") return null;
    return (
      <button
        type="button"
        onClick={() => {
          setExpanded(true);
          // Focus the textarea once it mounts. Two-frame wait covers React's
          // commit phase across all browsers; useEffect on `expanded` would
          // also work but this avoids an extra render.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => taRef.current?.focus())
          );
        }}
        className="muted"
        style={{
          background: "none",
          border: "1px dashed rgba(0,0,0,0.18)",
          borderRadius: "4px",
          padding: "0.25rem 0.55rem",
          fontSize: "0.8rem",
          cursor: "pointer",
          color: "var(--muted)",
        }}
      >
        + note
      </button>
    );
  }

  return (
    <textarea
      ref={taRef}
      value={text}
      placeholder="met at lunch, follow up about…"
      onChange={(e) => {
        setText(e.target.value);
        scheduleSave(e.target.value);
      }}
      onBlur={() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        writeNote(id, text);
        if (text.length === 0) setExpanded(false);
      }}
      rows={text.length > 80 ? 3 : 2}
      style={{
        width: "100%",
        marginTop: "0.4rem",
        padding: "0.4rem 0.55rem",
        fontSize: "0.85rem",
        fontFamily: "inherit",
        borderRadius: "4px",
        border: "1px solid rgba(0,0,0,0.12)",
        background: "rgba(241, 196, 15, 0.05)",
        resize: "vertical",
        boxSizing: "border-box",
      }}
    />
  );
}
