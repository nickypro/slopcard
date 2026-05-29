// Per-handle rate limit for /discover refresh runs. Guards OpenRouter spend:
// without this, a signed-in user can fan out parallel `refresh:true` calls
// and drain the budget at ~$0.50/request. In-memory, single-instance only.
//
// Two guards:
//   - Concurrency: at most 1 in-flight run per handle. A newer claim
//     preempts the older one by aborting its returned signal.
//   - Quota: rolling 24h window of *counted* releases. Free-handle
//     whitelist gets a higher cap but is not exempt (the owner's
//     account can still be compromised).
//
// Cache hits do not count — the caller signals via `release({counted})`
// after deciding whether the run actually hit OpenRouter.

const WINDOW_MS = 24 * 60 * 60 * 1000;
const CAP_DEFAULT = 20;
const CAP_FREE = 100;

interface HandleState {
  inflight: AbortController | null;
  // Timestamps (ms epoch) of counted releases, sorted ascending.
  counted: number[];
}

const state = new Map<string, HandleState>();

export interface RateLimitClaim {
  // AbortSignal that fires if a newer request for this handle preempts us.
  signal: AbortSignal;
  // Call when the request finishes (cache hit OR success OR error). Releases
  // the concurrency slot. Pass `counted: true` to increment the daily counter.
  release(opts: { counted: boolean }): void;
}

export type RateLimitDecision =
  | {
      allow: true;
      claim: RateLimitClaim;
    }
  | {
      allow: false;
      reason: "quota_exceeded";
      retryAfterSec: number;
    };

function getState(key: string): HandleState {
  let s = state.get(key);
  if (!s) {
    s = { inflight: null, counted: [] };
    state.set(key, s);
  }
  return s;
}

function prune(s: HandleState, now: number): void {
  const cutoff = now - WINDOW_MS;
  // Counted is sorted ascending; drop the leading entries that fell out.
  let i = 0;
  while (i < s.counted.length && s.counted[i] <= cutoff) i++;
  if (i > 0) s.counted.splice(0, i);
}

export function claimDiscoverSlot(args: {
  handle: string;
  isFreeHandle: boolean;
}): RateLimitDecision {
  const key = args.handle.toLowerCase();
  const cap = args.isFreeHandle ? CAP_FREE : CAP_DEFAULT;
  const now = Date.now();
  const s = getState(key);

  prune(s, now);

  if (s.counted.length >= cap) {
    // Window slides when the oldest entry ages out.
    const oldest = s.counted[0];
    const retryAfterMs = Math.max(0, oldest + WINDOW_MS - now);
    return {
      allow: false,
      reason: "quota_exceeded",
      retryAfterSec: Math.ceil(retryAfterMs / 1000),
    };
  }

  // Preempt any in-flight request for this handle. The user pressed the
  // button again — newer wins.
  if (s.inflight) {
    s.inflight.abort();
  }

  const controller = new AbortController();
  s.inflight = controller;

  let released = false;
  const release = (opts: { counted: boolean }): void => {
    if (released) return;
    released = true;
    // Only clear inflight if it's still ours — a newer claim may have
    // already replaced (and aborted) us.
    const cur = getState(key);
    if (cur.inflight === controller) {
      cur.inflight = null;
    }
    if (opts.counted) {
      cur.counted.push(Date.now());
    }
  };

  return {
    allow: true,
    claim: { signal: controller.signal, release },
  };
}

// ── Cheap-route quota ────────────────────────────────────────────────────
// Smaller, simpler bucket for routes whose per-call cost is bounded (no
// LLM, no upstream fan-out). Purposes split by `kind`:
//   - "vector":    /discover-vector free vector-only run
//   - "saved":     /saved-summary slot-overlap rollup
//   - "closeness": /closeness-rank per-page cosine sort
// 60 calls per handle per 5-min rolling window. Concurrency cap of 3 per
// (handle, kind) so a runaway client can't pile up dozens of in-flight
// requests. Kinds share no state — burning vector doesn't affect saved.

const CHEAP_WINDOW_MS = 5 * 60 * 1000;
const CHEAP_CAP = 60;
const CHEAP_CONCURRENCY = 3;

interface CheapState {
  inflight: number;
  // Timestamps of *completed* calls, sorted ascending.
  hits: number[];
}

const cheapState = new Map<string, CheapState>();

function getCheapState(key: string): CheapState {
  let s = cheapState.get(key);
  if (!s) {
    s = { inflight: 0, hits: [] };
    cheapState.set(key, s);
  }
  return s;
}

function pruneCheap(s: CheapState, now: number): void {
  const cutoff = now - CHEAP_WINDOW_MS;
  let i = 0;
  while (i < s.hits.length && s.hits[i] <= cutoff) i++;
  if (i > 0) s.hits.splice(0, i);
}

export type CheapKind = "vector" | "saved" | "closeness";

export type CheapClaimDecision =
  | { allow: true; release(): void }
  | { allow: false; reason: "quota_exceeded" | "too_many_inflight"; retryAfterSec: number };

export function claimCheapSlot(args: {
  handle: string;
  kind: CheapKind;
}): CheapClaimDecision {
  const key = `${args.kind}:${args.handle.toLowerCase()}`;
  const now = Date.now();
  const s = getCheapState(key);
  pruneCheap(s, now);

  if (s.hits.length >= CHEAP_CAP) {
    const oldest = s.hits[0];
    const retryAfterMs = Math.max(0, oldest + CHEAP_WINDOW_MS - now);
    return {
      allow: false,
      reason: "quota_exceeded",
      retryAfterSec: Math.ceil(retryAfterMs / 1000),
    };
  }
  if (s.inflight >= CHEAP_CONCURRENCY) {
    return {
      allow: false,
      reason: "too_many_inflight",
      retryAfterSec: 1,
    };
  }

  s.inflight += 1;
  let released = false;
  return {
    allow: true,
    release: () => {
      if (released) return;
      released = true;
      const cur = getCheapState(key);
      if (cur.inflight > 0) cur.inflight -= 1;
      cur.hits.push(Date.now());
    },
  };
}

// ── Photo-fetch quota ────────────────────────────────────────────────────
// Per-handle cap on cache-miss photo fetches. Cache hits don't count
// (caller decides when to claim — call this BEFORE upstream fetch). 100
// per 15-min sliding window is more than a full discover render's worth
// of new faces and still bounded enough that a runaway client can't fill
// disk with attacker-chosen ids.

const PHOTO_WINDOW_MS = 15 * 60 * 1000;
const PHOTO_CAP = 100;

interface PhotoState {
  hits: number[];
}

const photoState = new Map<string, PhotoState>();

export type PhotoClaimDecision =
  | { allow: true }
  | { allow: false; retryAfterSec: number };

export function claimPhotoFetch(handle: string): PhotoClaimDecision {
  const key = handle.toLowerCase();
  const now = Date.now();
  let s = photoState.get(key);
  if (!s) {
    s = { hits: [] };
    photoState.set(key, s);
  }
  const cutoff = now - PHOTO_WINDOW_MS;
  let i = 0;
  while (i < s.hits.length && s.hits[i] <= cutoff) i++;
  if (i > 0) s.hits.splice(0, i);

  if (s.hits.length >= PHOTO_CAP) {
    const oldest = s.hits[0];
    const retryAfterMs = Math.max(0, oldest + PHOTO_WINDOW_MS - now);
    return { allow: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) };
  }
  s.hits.push(now);
  return { allow: true };
}

// Test-only escape hatch — clears all internal state.
export function __resetRateLimitState(): void {
  state.clear();
  cheapState.clear();
  photoState.clear();
}
