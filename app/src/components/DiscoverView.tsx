"use client";

import { useEffect, useState } from "react";
import MetToggle from "@/components/MetToggle";
import SavedNotes from "@/components/SavedNotes";
import { PROMPT_PRESETS } from "@/lib/swapcard/prompt-presets";

interface AttendeeProfile {
  firstName: string;
  lastName: string;
  jobTitle: string;
  company: string;
  country: string;
  careerStage: string;
  biography: string;
  expertise: string[];
  interests: string[];
  needHelp: string;
  helpOthers: string;
}

interface Recommendation {
  personId: string | null;
  name: string;
  role: string;
  company: string;
  country: string;
  rating: number;
  why: string;
  talkingPoints: string[];
  suggestedOpener: string;
  swapcardUrl: string;
  linkedinUrl: string;
  photoUrl: string | null;
  pool: "primary" | "lateral";
  // Optional so runs cached before iter-14 (no slot annotation) render
  // without a badge instead of crashing. null = unknown, 0 = no overlap,
  // >0 = that many open 30-min slots on Swapcard.
  freeSlotCount?: number | null;
}

interface RetrievedCandidate {
  personId: string | null;
  eventPeopleId: string | null;
  name: string;
  role: string;
  company: string;
  country: string;
  photoUrl: string | null;
  swapcardUrl: string;
  semRank: number | null;
  bm25Rank: number | null;
  score: number;
}

interface DiscoverRun {
  // Present on runs saved after the share-permalink feature shipped.
  // Older cached runs lack it; the share button hides when missing.
  runId?: number;
  generatedAt: number;
  sheetSignature: string;
  totalAttendees: number;
  primaryRetrieved: number;
  lateralRetrieved: number;
  searchQuery: { query: string; wanted: string[]; lateral: string[] };
  recommendations: Recommendation[];
  retrieved?: {
    primary: RetrievedCandidate[];
    lateral: RetrievedCandidate[];
  };
}

interface Props {
  initialRun: DiscoverRun | null;
  requesterProfile: AttendeeProfile | null;
  requesterPersonId: string | null;
  needsByok: boolean;
  hasOpenRouterCookie: boolean;
  // Permalink mode: show the cached run only. No controls, no regenerate,
  // no BYOK — just the profile panel + result sections + a back link.
  readOnly?: boolean;
}

const BYOK_STORAGE_KEY = "slopcard:openrouter_key";
const CUSTOM_PROMPT_STORAGE_KEY = "slopcard:discover_prompt";
// Saved-person IDs persist across sessions so attendees can flag someone in
// the morning and find them again that evening. Pure client-side, no schema.
const SAVED_STORAGE_KEY = "slopcard:saved_person_ids";

type Phase =
  | "starting"
  | "cached"
  | "loading_attendees"
  | "building_query"
  | "vectorising"
  | "retrieving"
  | "ranking"
  | "saving"
  | "done"
  | "error";

const PHASE_LABEL: Record<Phase, string> = {
  starting: "starting…",
  cached: "loading cached run…",
  loading_attendees: "loading attendees…",
  building_query: "LLM call 1: building search query…",
  vectorising: "vectorising query…",
  retrieving: "hybrid retrieval (semantic + BM25)…",
  ranking: "LLM call 2: ranking + writing rationales…",
  saving: "caching result…",
  done: "done",
  error: "error",
};

const PHASE_ORDER: Phase[] = [
  "starting",
  "loading_attendees",
  "building_query",
  "vectorising",
  "retrieving",
  "ranking",
  "saving",
  "done",
];

export default function DiscoverView({
  initialRun,
  requesterProfile,
  requesterPersonId,
  needsByok,
  hasOpenRouterCookie,
  readOnly = false,
}: Props) {
  const [run, setRun] = useState<DiscoverRun | null>(initialRun);
  // Pin the server-loaded LLM run separately so the user can flip back to it
  // after running a vector preview without re-paying the LLM cost. A run is
  // identified as LLM-tier by `runId !== undefined` (vector runs aren't
  // persisted and have no row id).
  const [cachedLlmRun, setCachedLlmRun] = useState<DiscoverRun | null>(
    initialRun?.runId !== undefined ? initialRun : null
  );
  const [busy, setBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [phaseMeta, setPhaseMeta] = useState<Record<string, unknown> | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");
  const [byokKey, setByokKey] = useState("");
  const [oauthBanner, setOauthBanner] = useState<
    { kind: "ok" | "error"; text: string } | null
  >(null);
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [savedOnly, setSavedOnly] = useState(false);

  // Hydrate localStorage-persisted fields after mount (avoids SSR hydration
  // mismatch since localStorage is undefined on the server).
  useEffect(() => {
    try {
      const key = localStorage.getItem(BYOK_STORAGE_KEY);
      if (key) setByokKey(key);
      const prompt = localStorage.getItem(CUSTOM_PROMPT_STORAGE_KEY);
      if (prompt) setCustomPrompt(prompt);
      const saved = localStorage.getItem(SAVED_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setSavedIds(new Set(parsed.filter((x) => typeof x === "string")));
        }
      }
    } catch {
      /* localStorage unavailable or JSON malformed */
    }
  }, []);

  function toggleSaved(personId: string | null) {
    if (!personId) return;
    setSavedIds((prev) => {
      const next = new Set(prev);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      try {
        localStorage.setItem(SAVED_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  // Surface ?openrouter=linked / ?openrouter_error=... from the OAuth
  // round-trip, then strip the params so a reload doesn't re-show them.
  useEffect(() => {
    const url = new URL(window.location.href);
    const linked = url.searchParams.get("openrouter");
    const err = url.searchParams.get("openrouter_error");
    if (linked === "linked") {
      setOauthBanner({
        kind: "ok",
        text: "OpenRouter linked — your key is saved as an httpOnly cookie.",
      });
    } else if (err) {
      setOauthBanner({
        kind: "error",
        text: `OpenRouter sign-in failed: ${err}`,
      });
    }
    if (linked || err) {
      url.searchParams.delete("openrouter");
      url.searchParams.delete("openrouter_error");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  async function generate(refresh: boolean) {
    setBusy(true);
    setError(null);
    setPhase("starting");
    setPhaseMeta(null);
    // Persist user inputs across refreshes — they're not secrets the same way
    // a server-side session is, and re-typing a long prompt is annoying.
    try {
      if (byokKey.trim()) {
        localStorage.setItem(BYOK_STORAGE_KEY, byokKey.trim());
      }
      if (customPrompt.trim()) {
        localStorage.setItem(CUSTOM_PROMPT_STORAGE_KEY, customPrompt.trim());
      }
    } catch {
      /* localStorage unavailable */
    }
    try {
      const res = await fetch("/api/swapcard/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          refresh,
          customPrompt: customPrompt.trim() || undefined,
          openrouterKey: byokKey.trim() || undefined,
        }),
      });
      if (!res.ok || !res.body) {
        // Non-streaming error path (auth / validation rejects before SSE starts).
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `discover failed (${res.status})`);
        setPhase(null);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let gotRun: DiscoverRun | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Split on the SSE event terminator \n\n. Anything left over is a
        // partial event; carry it into the next chunk.
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const raw of events) {
          const line = raw.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          let evt: { phase?: Phase; meta?: Record<string, unknown>; run?: DiscoverRun; error?: string };
          try {
            evt = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (evt.phase === "error") {
            setError(evt.error ?? "discover failed");
            setPhase(null);
            return;
          }
          if (evt.phase) {
            setPhase(evt.phase);
            setPhaseMeta(evt.meta ?? null);
          }
          if (evt.run) gotRun = evt.run;
        }
      }
      if (gotRun) {
        setRun(gotRun);
        // Stash the LLM-tier run so the user can flip back to it later.
        if (gotRun.runId !== undefined) setCachedLlmRun(gotRun);
        setPhase(null);
      } else if (!error) {
        setError("stream ended without a run");
        setPhase(null);
      }
    } catch (err) {
      setError((err as Error).message);
      setPhase(null);
    } finally {
      setBusy(false);
    }
  }

  // Free vector-only tier — replaces whatever's on screen with the
  // retrieval-only result. Auto-opens the raw-retrieval list since that's
  // the only thing this tier produces (no LLM picks). The LLM run is still
  // cached server-side, so clicking "regenerate" later goes back to it.
  async function runVectorPreview() {
    setPreviewBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/swapcard/discover-vector", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customPrompt: customPrompt.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        run?: DiscoverRun;
        error?: string;
      };
      if (!res.ok || !data.ok || !data.run) {
        setError(data.error ?? `vector preview failed (${res.status})`);
        return;
      }
      setRun(data.run);
      setShowRaw(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPreviewBusy(false);
    }
  }

  const controls = (
    <>
      {requesterProfile ? (
        <ProfilePanel profile={requesterProfile} personId={requesterPersonId} />
      ) : null}

      <div className="panel discover-controls" style={{ marginBottom: "1rem" }}>
        <label
          htmlFor="customPrompt"
          style={{ display: "block", marginBottom: "0.4rem", fontWeight: 500 }}
        >
          extra guidance for the LLM (optional)
        </label>
        <div
          className="preset-row"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.35rem",
            marginBottom: "0.5rem",
          }}
        >
          {PROMPT_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="btn ghost"
              onClick={() => {
                // Replace rather than append — presets are full thoughts;
                // mixing with a previous preset confuses the LLM more than
                // it helps. The textarea is editable so the user can layer
                // on their own clauses after picking.
                if (
                  customPrompt.trim().length === 0 ||
                  customPrompt === p.prompt ||
                  confirm(
                    "replace your current prompt with this preset? (you can edit it after)"
                  )
                ) {
                  setCustomPrompt(p.prompt);
                }
              }}
              style={{
                fontSize: "0.78rem",
                padding: "0.3rem 0.6rem",
                fontWeight: customPrompt === p.prompt ? 600 : 400,
              }}
              title={p.prompt}
            >
              {p.emoji} {p.label}
            </button>
          ))}
        </div>
        <textarea
          id="customPrompt"
          value={customPrompt}
          onChange={(e) => setCustomPrompt(e.target.value)}
          placeholder="e.g. focus on mechanistic interpretability researchers; weight European attendees higher; avoid recruiters"
          rows={3}
          style={{
            width: "100%",
            padding: "0.55rem",
            fontSize: "0.9rem",
            fontFamily: "inherit",
            resize: "vertical",
          }}
        />
        <p
          className="muted"
          style={{ fontSize: "0.8rem", margin: "0.4rem 0 0" }}
        >
          appended to your conference goals before the LLM picks candidates.
          saved in this browser so a refresh doesn&apos;t lose it.
        </p>

        {oauthBanner ? (
          <p
            className={oauthBanner.kind === "ok" ? "muted" : "error"}
            style={{ marginTop: "1rem", fontSize: "0.85rem" }}
          >
            {oauthBanner.text}
          </p>
        ) : null}

        {/* OAuth cookie status: show the disconnect option ANY time the
            cookie is present, including for free handles. Free handles got
            the env-key as a default in the old code, which made an OAuth
            cookie silently ineffective AND removed the affordance to opt
            out of the env-key path. Now: user-supplied key always wins
            (see /api/swapcard/discover precedence rules), and disconnect
            cleanly removes the cookie. */}
        {hasOpenRouterCookie ? (
          <p
            className="muted"
            style={{ fontSize: "0.85rem", marginTop: "1rem" }}
          >
            signed in with OpenRouter — your key is held server-side in an
            httpOnly cookie.{" "}
            <a href="/api/auth/openrouter/start">re-link</a>
            {" · "}
            <button
              type="button"
              onClick={async () => {
                if (!confirm("disconnect your OpenRouter key from slopcard?")) return;
                const res = await fetch("/api/auth/openrouter/disconnect", {
                  method: "POST",
                });
                if (res.ok) {
                  window.location.reload();
                } else {
                  setOauthBanner({
                    kind: "error",
                    text: `disconnect failed (${res.status}) — try again`,
                  });
                }
              }}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                color: "inherit",
                textDecoration: "underline",
                cursor: "pointer",
                font: "inherit",
              }}
            >
              disconnect
            </button>
          </p>
        ) : null}
        {/* Free handles get the env key by default. They can opt INTO their
            own key (OAuth or paste) to override — useful when the owner
            wants their personal OpenRouter quota / billing instead of the
            server's shared key. Only shows when no cookie is already set. */}
        {!needsByok && !hasOpenRouterCookie ? (
          <p
            className="muted"
            style={{ fontSize: "0.85rem", marginTop: "1rem" }}
          >
            using the server-side OpenRouter key by default.{" "}
            <a href="/api/auth/openrouter/start">
              sign in with OpenRouter →
            </a>{" "}
            to use your own.
          </p>
        ) : null}
        {needsByok ? (
          hasOpenRouterCookie ? null : (
            <>
              <div
                style={{
                  marginTop: "1rem",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.6rem",
                  flexWrap: "wrap",
                }}
              >
                <a
                  className="btn"
                  href="/api/auth/openrouter/start"
                  style={{ textDecoration: "none" }}
                >
                  sign in with OpenRouter →
                </a>
                <span className="muted" style={{ fontSize: "0.85rem" }}>
                  or paste a key below
                </span>
              </div>
              <label
                htmlFor="byokKey"
                style={{
                  display: "block",
                  marginTop: "1rem",
                  marginBottom: "0.4rem",
                  fontWeight: 500,
                }}
              >
                your OpenRouter API key
              </label>
              <input
                id="byokKey"
                type="password"
                autoComplete="off"
                value={byokKey}
                onChange={(e) => setByokKey(e.target.value)}
                placeholder="sk-or-v1-…"
                style={{
                  width: "100%",
                  padding: "0.55rem",
                  fontSize: "0.85rem",
                  fontFamily: "monospace",
                }}
              />
              <p
                className="muted"
                style={{ fontSize: "0.8rem", margin: "0.4rem 0 0" }}
              >
                opus 4.8 runs cost ~$0.50 each so we can&apos;t cover them by
                default. get a key at{" "}
                <a
                  href="https://openrouter.ai/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  openrouter.ai/keys
                </a>{" "}
                — stays in this browser only, sent server-side only at submit
                time.
              </p>
            </>
          )
        ) : null}

        {error ? <p className="error">{error}</p> : null}
        {busy ? <PhaseTracker phase={phase} meta={phaseMeta} /> : null}

        <div
          style={{
            marginTop: "1rem",
            display: "flex",
            gap: "0.6rem",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <button
            className="btn primary"
            disabled={
              busy ||
              previewBusy ||
              (needsByok && !hasOpenRouterCookie && !byokKey.trim())
            }
            onClick={() => generate(true)}
          >
            {busy
              ? "running…"
              : run?.runId !== undefined
                ? "regenerate (LLM, paid)"
                : "generate recommendations (LLM) →"}
          </button>
          {/* Free vector-only tier — no LLM, no key, no quota. Lives next to
              the primary CTA so users discover it without scrolling. */}
          <button
            className="btn"
            disabled={busy || previewBusy}
            onClick={runVectorPreview}
            style={{ fontSize: "0.85rem" }}
            title="semantic + BM25 retrieval against your own profile — no LLM, no key needed"
          >
            {previewBusy ? "loading…" : "vector preview (free)"}
          </button>
        </div>
      </div>
    </>
  );

  // Read-only permalink mode: collapse the no-run state to a single panel and
  // skip every control. Owner-only gating already happened on the server.
  if (readOnly && !run) {
    return (
      <>
        <p style={{ marginBottom: "1rem" }}>
          <a href="/discover" className="muted" style={{ fontSize: "0.9rem" }}>
            ← back to /discover
          </a>
        </p>
        <div className="panel">
          <p>this run no longer exists.</p>
        </div>
      </>
    );
  }

  if (!run) {
    return controls;
  }

  // Filter to saved-only when the toggle is on AND the user actually has
  // at least one save. If no saves yet, we silently fall through to the
  // unfiltered list so the toggle button doesn't render an empty result
  // page when first turned on accidentally.
  const filtered =
    savedOnly && savedIds.size > 0
      ? run.recommendations.filter((r) => r.personId && savedIds.has(r.personId))
      : run.recommendations;

  const byRating = new Map<number, Recommendation[]>();
  for (const r of filtered) {
    const list = byRating.get(r.rating) ?? [];
    list.push(r);
    byRating.set(r.rating, list);
  }

  // Share-link writes to clipboard. Older cached runs without runId hide the
  // button rather than copy a broken URL.
  async function copyShareLink() {
    if (!run?.runId) return;
    try {
      const url = `${window.location.origin}/discover/run/${run.runId}`;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable; silently no-op */
    }
  }

  return (
    <>
      {readOnly ? (
        <>
          <p style={{ marginBottom: "1rem" }}>
            <a
              href="/discover"
              className="muted"
              style={{ fontSize: "0.9rem" }}
            >
              ← back to /discover
            </a>
          </p>
          {requesterProfile ? (
            <ProfilePanel
              profile={requesterProfile}
              personId={requesterPersonId}
            />
          ) : null}
        </>
      ) : (
        controls
      )}

      <div
        className="muted"
        style={{ fontSize: "0.85rem", marginBottom: "1rem" }}
      >
        generated {new Date(run.generatedAt).toLocaleString()} ·{" "}
        {run.totalAttendees} attendees scanned · {run.primaryRetrieved} primary
        + {run.lateralRetrieved} lateral candidates retrieved ·{" "}
        {run.recommendations.length} picks
        {run.retrieved ? (
          <button
            type="button"
            className="btn ghost"
            onClick={() => setShowRaw((v) => !v)}
            style={{
              marginLeft: "0.75rem",
              fontSize: "0.8rem",
              padding: "0.35rem 0.7rem",
            }}
          >
            {showRaw ? "hide raw retrieval" : "show raw retrieval"}
          </button>
        ) : null}
        {!readOnly && run.runId ? (
          <button
            type="button"
            className="btn ghost"
            onClick={copyShareLink}
            style={{
              marginLeft: "0.5rem",
              fontSize: "0.8rem",
              padding: "0.35rem 0.7rem",
            }}
            title="copy a permalink to this run"
          >
            {copied ? "copied!" : "copy share link →"}
          </button>
        ) : null}
        {!readOnly && run.runId === undefined && cachedLlmRun ? (
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              setRun(cachedLlmRun);
              setShowRaw(false);
            }}
            style={{
              marginLeft: "0.5rem",
              fontSize: "0.8rem",
              padding: "0.35rem 0.7rem",
            }}
            title="show the LLM-ranked picks you already paid for"
          >
            ← back to LLM picks
          </button>
        ) : null}
        {savedIds.size > 0 ? (
          <button
            type="button"
            className="btn ghost"
            onClick={() => setSavedOnly((v) => !v)}
            style={{
              marginLeft: "0.5rem",
              fontSize: "0.8rem",
              padding: "0.35rem 0.7rem",
            }}
            title="filter to only people you've saved"
          >
            {savedOnly
              ? `★ saved only (${savedIds.size}) ✓`
              : `★ show saved only (${savedIds.size})`}
          </button>
        ) : null}
      </div>

      {showRaw && run.retrieved ? (
        <RawRetrievalList
          primary={
            savedOnly && savedIds.size > 0
              ? run.retrieved.primary.filter(
                  (c) => c.personId && savedIds.has(c.personId)
                )
              : run.retrieved.primary
          }
          lateral={
            savedOnly && savedIds.size > 0
              ? run.retrieved.lateral.filter(
                  (c) => c.personId && savedIds.has(c.personId)
                )
              : run.retrieved.lateral
          }
          savedIds={savedIds}
          onToggleSave={toggleSaved}
        />
      ) : null}

      {[5, 4, 3, 2, 1].map((rating) => {
        const list = byRating.get(rating);
        if (!list || !list.length) return null;
        return (
          <section key={rating} style={{ marginBottom: "2rem" }}>
            <h2
              className="title"
              style={{ fontSize: "1.3rem", marginBottom: "0.75rem" }}
            >
              {"★".repeat(rating)}
              <span className="muted" style={{ fontSize: "0.9rem" }}>
                {" "}
                ({list.length})
              </span>
            </h2>
            {list.map((r, i) => (
              <RecCard
                key={`${rating}-${i}-${r.name}`}
                rec={r}
                saved={!!(r.personId && savedIds.has(r.personId))}
                onToggleSave={() => toggleSaved(r.personId)}
              />
            ))}
          </section>
        );
      })}

      {run.recommendations.length === 0 ? (
        <div className="panel">
          {readOnly ? (
            <p>no picks returned in this cached run.</p>
          ) : (
            <p>
              no picks returned. try{" "}
              <button
                className="btn ghost"
                onClick={() => generate(true)}
                disabled={busy}
              >
                regenerate
              </button>
              .
            </p>
          )}
        </div>
      ) : null}
    </>
  );
}

// Routes through our server-side photo cache (/api/swapcard/photo/<id>) so
// rotating upstream Swapcard CDN URLs don't break old discover runs. The `w`
// query param is a hint only — the route serves original bytes today, but
// keeping it in the URL means a future resize layer doesn't need a UI change.
// Returns null when there's no personId so the caller renders a placeholder.
function thumbUrl(personId: string | null, width = 96): string | null {
  if (!personId) return null;
  return `/api/swapcard/photo/${encodeURIComponent(personId)}?w=${width}`;
}

// The unranked candidate pool — what the retrieval layer surfaces before the
// LLM picks 25. Useful for verifying the retriever is doing the right thing
// and for browsing past what the LLM chose.
function RawRetrievalList({
  primary,
  lateral,
  savedIds,
  onToggleSave,
}: {
  primary: RetrievedCandidate[];
  lateral: RetrievedCandidate[];
  savedIds: Set<string>;
  onToggleSave: (personId: string | null) => void;
}) {
  return (
    <div
      className="panel"
      style={{
        marginBottom: "1.5rem",
        maxHeight: "60vh",
        overflowY: "auto",
      }}
    >
      <p
        className="muted"
        style={{
          margin: "0 0 0.5rem",
          fontSize: "0.75rem",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        raw retrieval pool — primary ({primary.length}) + lateral ({lateral.length})
      </p>
      <RawSection
        label="primary"
        candidates={primary}
        savedIds={savedIds}
        onToggleSave={onToggleSave}
      />
      {lateral.length > 0 ? (
        <RawSection
          label="lateral (wildcard)"
          candidates={lateral}
          savedIds={savedIds}
          onToggleSave={onToggleSave}
        />
      ) : null}
    </div>
  );
}

function RawSection({
  label,
  candidates,
  savedIds,
  onToggleSave,
}: {
  label: string;
  candidates: RetrievedCandidate[];
  savedIds: Set<string>;
  onToggleSave: (personId: string | null) => void;
}) {
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <p
        className="muted"
        style={{
          fontSize: "0.78rem",
          fontWeight: 500,
          margin: "0.5rem 0 0.3rem",
        }}
      >
        {label}
      </p>
      <ol style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
        {candidates.map((c, i) => (
          <li
            key={`${label}-${i}-${c.name}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.6rem",
              padding: "0.35rem 0",
              borderBottom: "1px solid rgba(0,0,0,0.05)",
              fontSize: "0.85rem",
            }}
          >
            <span
              className="muted"
              style={{
                fontFamily: "monospace",
                fontSize: "0.75rem",
                width: "2.2em",
                textAlign: "right",
                flexShrink: 0,
              }}
            >
              {i + 1}.
            </span>
            {thumbUrl(c.personId ?? c.eventPeopleId, 56) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={thumbUrl(c.personId ?? c.eventPeopleId, 56)!}
                alt=""
                width={28}
                height={28}
                referrerPolicy="no-referrer"
                loading="lazy"
                style={{
                  borderRadius: "50%",
                  flexShrink: 0,
                  background: "rgba(0,0,0,0.06)",
                  objectFit: "cover",
                }}
              />
            ) : (
              <div
                aria-hidden
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  background: "rgba(0,0,0,0.06)",
                  flexShrink: 0,
                }}
              />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>{c.name}</strong>
              {c.role || c.company ? (
                <span className="muted" style={{ marginLeft: "0.4rem" }}>
                  {[c.role, c.company, c.country].filter(Boolean).join(" · ")}
                </span>
              ) : null}
            </div>
            <span
              className="muted"
              style={{
                fontFamily: "monospace",
                fontSize: "0.75rem",
                flexShrink: 0,
              }}
            >
              {c.semRank !== null ? `sem#${c.semRank + 1}` : ""}
              {c.bm25Rank !== null
                ? `${c.semRank !== null ? " / " : ""}bm25#${c.bm25Rank + 1}`
                : ""}
            </span>
            {c.swapcardUrl ? (
              <a
                href={c.swapcardUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: "0.8rem", flexShrink: 0 }}
              >
                ↗
              </a>
            ) : null}
            {c.personId ? (
              <button
                type="button"
                onClick={() => onToggleSave(c.personId)}
                aria-label={
                  savedIds.has(c.personId)
                    ? "unsave this person"
                    : "save this person"
                }
                title={savedIds.has(c.personId) ? "unsave" : "save for later"}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "0.95rem",
                  lineHeight: 1,
                  padding: "0.25rem 0.4rem",
                  color: savedIds.has(c.personId)
                    ? "var(--gold, #d4a93a)"
                    : "rgba(0,0,0,0.25)",
                  flexShrink: 0,
                }}
              >
                {savedIds.has(c.personId) ? "★" : "☆"}
              </button>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function ProfilePanel({
  profile,
  personId,
}: {
  profile: AttendeeProfile;
  personId: string | null;
}) {
  const photoSrc = thumbUrl(personId, 128);
  const meta = [
    profile.jobTitle,
    profile.company ? `at ${profile.company}` : "",
    profile.country ? `(${profile.country})` : "",
    profile.careerStage,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="panel" style={{ marginBottom: "1rem" }}>
      <div
        style={{
          display: "flex",
          gap: "1rem",
          alignItems: "flex-start",
          marginBottom: profile.biography ? "0.75rem" : 0,
        }}
      >
        {photoSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photoSrc}
            alt=""
            width={64}
            height={64}
            referrerPolicy="no-referrer"
            style={{
              borderRadius: "50%",
              objectFit: "cover",
              flexShrink: 0,
              background: "rgba(0,0,0,0.06)",
            }}
          />
        ) : (
          <div
            aria-hidden
            style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              background: "rgba(0,0,0,0.06)",
              flexShrink: 0,
            }}
          />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: "1.15rem" }}>
            {[profile.firstName, profile.lastName].filter(Boolean).join(" ")}
            <span
              className="muted"
              style={{ fontSize: "0.75rem", marginLeft: "0.5rem", fontWeight: 400 }}
            >
              your context
            </span>
          </h2>
          {meta ? (
            <div className="muted" style={{ fontSize: "0.85rem" }}>
              {meta}
            </div>
          ) : null}
        </div>
      </div>
      {profile.biography ? (
        <p style={{ margin: "0 0 0.6rem", fontSize: "0.9rem" }}>
          {profile.biography}
        </p>
      ) : null}
      {profile.expertise.length ? (
        <ProfileTags label="expertise" items={profile.expertise} />
      ) : null}
      {profile.interests.length ? (
        <ProfileTags label="interests" items={profile.interests} />
      ) : null}
      {profile.needHelp ? (
        <ProfileLine label="seeking" text={profile.needHelp} />
      ) : null}
      {profile.helpOthers ? (
        <ProfileLine label="offering" text={profile.helpOthers} />
      ) : null}
    </div>
  );
}

function ProfileTags({ label, items }: { label: string; items: string[] }) {
  return (
    <div style={{ marginBottom: "0.5rem" }}>
      <span
        className="muted"
        style={{
          fontSize: "0.7rem",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginRight: "0.5rem",
        }}
      >
        {label}
      </span>
      {items.map((t, i) => (
        <span
          key={i}
          style={{
            display: "inline-block",
            padding: "0.15rem 0.5rem",
            margin: "0 0.25rem 0.25rem 0",
            background: "rgba(0,0,0,0.06)",
            borderRadius: 999,
            fontSize: "0.78rem",
          }}
        >
          {t}
        </span>
      ))}
    </div>
  );
}

function ProfileLine({ label, text }: { label: string; text: string }) {
  return (
    <p style={{ margin: "0.3rem 0", fontSize: "0.85rem" }}>
      <span
        className="muted"
        style={{
          fontSize: "0.7rem",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginRight: "0.5rem",
        }}
      >
        {label}
      </span>
      {text}
    </p>
  );
}

function PhaseTracker({
  phase,
  meta,
}: {
  phase: Phase | null;
  meta: Record<string, unknown> | null;
}) {
  const currentIdx = phase ? PHASE_ORDER.indexOf(phase) : -1;
  return (
    <div
      className="phase-tracker"
      style={{
        marginTop: "0.75rem",
        padding: "0.75rem 1rem",
        background: "rgba(0,0,0,0.04)",
        borderRadius: 4,
        fontFamily: "monospace",
        fontSize: "0.85rem",
      }}
    >
      {PHASE_ORDER.filter((p) => p !== "done").map((p, idx) => {
        const isDone = currentIdx > idx || phase === "done";
        const isCurrent = phase === p;
        const mark = isCurrent ? "▶" : isDone ? "✓" : "·";
        const color = isCurrent
          ? "var(--ink)"
          : isDone
            ? "var(--ok, #2e7d32)"
            : "rgba(0,0,0,0.4)";
        return (
          <div
            key={p}
            style={{
              color,
              fontWeight: isCurrent ? 600 : 400,
              lineHeight: 1.5,
            }}
          >
            <span style={{ display: "inline-block", width: "1.2em" }}>{mark}</span>
            <span>[{p}]</span> {PHASE_LABEL[p]}
            {isCurrent && meta ? (
              <span className="muted" style={{ marginLeft: "0.5rem", fontWeight: 400 }}>
                ({Object.entries(meta)
                  .map(([k, v]) => `${k}: ${String(v)}`)
                  .join(", ")})
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// Inline "free slots" badge for a rec. Renders nothing when the count is
// unknown (null/undefined — typical for runs cached before iter-14, or for
// attendees who don't have an event_people_id mapped yet). Cached zero
// counts surface as "no overlap" so the user can tell the difference
// between "we checked and they're booked solid" and "we just don't know".
function SlotBadge({ count }: { count?: number | null }) {
  if (count === null || count === undefined) return null;
  const text =
    count === 0
      ? "· no overlap"
      : count === 1
        ? "· 1 free slot"
        : `· ${count} free slots`;
  return (
    <span
      className="muted"
      style={{ fontSize: "0.8rem", marginLeft: "0.35rem" }}
      title="free 30-min meeting slots on their Swapcard calendar — admin-refreshed every ≤15 min"
    >
      {text}
    </span>
  );
}

function RecCard({
  rec,
  saved,
  onToggleSave,
}: {
  rec: Recommendation;
  saved: boolean;
  onToggleSave: () => void;
}) {
  const photoSrc = thumbUrl(rec.personId);
  return (
    <div className="panel" style={{ marginBottom: "1rem" }}>
      <div
        className="rec-card-header"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", gap: "0.85rem", alignItems: "center" }}>
          {photoSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photoSrc}
              alt=""
              width={48}
              height={48}
              referrerPolicy="no-referrer"
              loading="lazy"
              style={{
                borderRadius: "50%",
                objectFit: "cover",
                flexShrink: 0,
                background: "rgba(0,0,0,0.06)",
              }}
            />
          ) : (
            <div
              aria-hidden
              style={{
                width: 48,
                height: 48,
                borderRadius: "50%",
                background: "rgba(0,0,0,0.06)",
                flexShrink: 0,
              }}
            />
          )}
          <h3 style={{ margin: 0 }}>
            {rec.name}
            {rec.pool === "lateral" ? (
              <span
                className="muted"
                style={{ fontSize: "0.8rem", marginLeft: "0.5rem" }}
              >
                · wildcard
              </span>
            ) : null}
          </h3>
        </div>
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            alignItems: "center",
            flexShrink: 0,
          }}
        >
          {rec.personId ? <MetToggle id={rec.personId} /> : null}
          {rec.personId ? (
            <button
              type="button"
              onClick={onToggleSave}
              aria-label={saved ? "unsave this person" : "save this person"}
              title={saved ? "unsave" : "save for later"}
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                fontSize: "1.1rem",
                lineHeight: 1,
                padding: "0.25rem 0.4rem",
                color: saved ? "var(--gold, #d4a93a)" : "rgba(0,0,0,0.25)",
                minHeight: "2.4rem",
                minWidth: "2.4rem",
              }}
            >
              {saved ? "★" : "☆"}
            </button>
          ) : null}
          <div className="muted rec-meta" style={{ fontSize: "0.85rem" }}>
            {[rec.role, rec.company, rec.country].filter(Boolean).join(" · ")}
            <SlotBadge count={rec.freeSlotCount} />
          </div>
        </div>
      </div>
      {rec.why ? <p style={{ marginTop: "0.6rem" }}>{rec.why}</p> : null}
      {rec.talkingPoints.length ? (
        <>
          <p
            className="muted"
            style={{
              fontSize: "0.8rem",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              marginTop: "0.6rem",
              marginBottom: "0.3rem",
            }}
          >
            talking points
          </p>
          <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
            {rec.talkingPoints.map((tp, i) => (
              <li key={i} style={{ marginBottom: "0.25rem" }}>
                {tp}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {rec.suggestedOpener ? (
        <>
          <p
            className="muted"
            style={{
              fontSize: "0.8rem",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              marginTop: "0.75rem",
              marginBottom: "0.3rem",
            }}
          >
            suggested opener
          </p>
          <blockquote
            style={{
              margin: 0,
              padding: "0.5rem 0.75rem",
              borderLeft: "3px solid var(--coral)",
              fontStyle: "italic",
            }}
          >
            {rec.suggestedOpener}
          </blockquote>
        </>
      ) : null}
      <div
        style={{
          marginTop: "0.75rem",
          display: "flex",
          gap: "1rem",
          fontSize: "0.85rem",
        }}
      >
        {rec.swapcardUrl ? (
          <a href={rec.swapcardUrl} target="_blank" rel="noopener noreferrer">
            Swapcard profile →
          </a>
        ) : null}
        {rec.linkedinUrl ? (
          <a href={rec.linkedinUrl} target="_blank" rel="noopener noreferrer">
            LinkedIn →
          </a>
        ) : null}
      </div>
      {/* Notes — compact mode renders nothing when the user hasn't jotted
          anything for this person yet, keeping rec cards tight. Notes are
          edited on /saved; here we just surface existing context inline. */}
      <SavedNotes id={rec.personId} mode="compact" />
    </div>
  );
}
