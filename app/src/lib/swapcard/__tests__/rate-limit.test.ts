import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  claimCheapSlot,
  claimDiscoverSlot,
  claimPhotoFetch,
  __resetRateLimitState,
} from "@/lib/swapcard/rate-limit";

describe("claimDiscoverSlot", () => {
  beforeEach(() => {
    __resetRateLimitState();
  });

  it("single claim → release works", () => {
    const decision = claimDiscoverSlot({ handle: "alice", isFreeHandle: false });
    expect(decision.allow).toBe(true);
    if (!decision.allow) throw new Error("unreachable");
    expect(decision.claim.signal.aborted).toBe(false);
    decision.claim.release({ counted: true });

    // A follow-up claim should also be allowed (slot was released).
    const next = claimDiscoverSlot({ handle: "alice", isFreeHandle: false });
    expect(next.allow).toBe(true);
  });

  it("second claim preempts first (first's signal fires)", () => {
    const first = claimDiscoverSlot({ handle: "alice", isFreeHandle: false });
    expect(first.allow).toBe(true);
    if (!first.allow) throw new Error("unreachable");
    expect(first.claim.signal.aborted).toBe(false);

    const second = claimDiscoverSlot({ handle: "alice", isFreeHandle: false });
    expect(second.allow).toBe(true);
    if (!second.allow) throw new Error("unreachable");

    expect(first.claim.signal.aborted).toBe(true);
    expect(second.claim.signal.aborted).toBe(false);
  });

  it("quota: 20 counted releases blocks the 21st with quota_exceeded", () => {
    for (let i = 0; i < 20; i++) {
      const d = claimDiscoverSlot({ handle: "alice", isFreeHandle: false });
      expect(d.allow).toBe(true);
      if (!d.allow) throw new Error("unreachable");
      d.claim.release({ counted: true });
    }

    const blocked = claimDiscoverSlot({
      handle: "alice",
      isFreeHandle: false,
    });
    expect(blocked.allow).toBe(false);
    if (blocked.allow) throw new Error("unreachable");
    expect(blocked.reason).toBe("quota_exceeded");
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("free handle: 100 counted releases blocks the 101st", () => {
    for (let i = 0; i < 100; i++) {
      const d = claimDiscoverSlot({ handle: "owner", isFreeHandle: true });
      expect(d.allow).toBe(true);
      if (!d.allow) throw new Error("unreachable");
      d.claim.release({ counted: true });
    }

    const blocked = claimDiscoverSlot({ handle: "owner", isFreeHandle: true });
    expect(blocked.allow).toBe(false);
    if (blocked.allow) throw new Error("unreachable");
    expect(blocked.reason).toBe("quota_exceeded");

    // And a non-free handle with the same name space still gets default cap —
    // but since we key by handle (case-insensitive), this confirms the cap is
    // resolved per-call, not stored. 100 already counted for "owner" means
    // even a non-free call would be blocked.
    const sameHandleNonFree = claimDiscoverSlot({
      handle: "owner",
      isFreeHandle: false,
    });
    expect(sameHandleNonFree.allow).toBe(false);
  });

  it("non-counted releases don't tick the quota", () => {
    for (let i = 0; i < 50; i++) {
      const d = claimDiscoverSlot({ handle: "alice", isFreeHandle: false });
      expect(d.allow).toBe(true);
      if (!d.allow) throw new Error("unreachable");
      d.claim.release({ counted: false });
    }

    // Still well under cap (0/20 counted).
    const next = claimDiscoverSlot({ handle: "alice", isFreeHandle: false });
    expect(next.allow).toBe(true);
  });

  it("retryAfterSec is computed correctly", () => {
    vi.useFakeTimers();
    try {
      const start = new Date("2026-05-29T00:00:00Z").getTime();
      vi.setSystemTime(start);

      // Burn the first slot at t=0.
      const first = claimDiscoverSlot({
        handle: "alice",
        isFreeHandle: false,
      });
      expect(first.allow).toBe(true);
      if (!first.allow) throw new Error("unreachable");
      first.claim.release({ counted: true });

      // Burn 19 more, each 1 hour later, so the oldest is at t=0 and the
      // 20th is at t=+19h.
      for (let i = 1; i < 20; i++) {
        vi.setSystemTime(start + i * 60 * 60 * 1000);
        const d = claimDiscoverSlot({
          handle: "alice",
          isFreeHandle: false,
        });
        expect(d.allow).toBe(true);
        if (!d.allow) throw new Error("unreachable");
        d.claim.release({ counted: true });
      }

      // Now at t=+19h we have 20 counted releases (oldest at t=0). Advance
      // to t=+20h and try the 21st — it should be blocked, with
      // retryAfterSec ≈ 4h (oldest ages out at t=+24h).
      vi.setSystemTime(start + 20 * 60 * 60 * 1000);
      const blocked = claimDiscoverSlot({
        handle: "alice",
        isFreeHandle: false,
      });
      expect(blocked.allow).toBe(false);
      if (blocked.allow) throw new Error("unreachable");
      expect(blocked.retryAfterSec).toBe(4 * 60 * 60);

      // Slide past the 24h boundary on the oldest entry — it should be
      // pruned and the next claim should succeed.
      vi.setSystemTime(start + 24 * 60 * 60 * 1000 + 1000);
      const ok = claimDiscoverSlot({ handle: "alice", isFreeHandle: false });
      expect(ok.allow).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("two different handles don't interfere", () => {
    const a1 = claimDiscoverSlot({ handle: "alice", isFreeHandle: false });
    const b1 = claimDiscoverSlot({ handle: "bob", isFreeHandle: false });
    expect(a1.allow).toBe(true);
    expect(b1.allow).toBe(true);
    if (!a1.allow || !b1.allow) throw new Error("unreachable");

    // Bob's claim shouldn't have aborted Alice's signal.
    expect(a1.claim.signal.aborted).toBe(false);
    expect(b1.claim.signal.aborted).toBe(false);

    // Burn Alice's quota — Bob should be unaffected.
    a1.claim.release({ counted: true });
    for (let i = 1; i < 20; i++) {
      const d = claimDiscoverSlot({ handle: "alice", isFreeHandle: false });
      if (!d.allow) throw new Error("unreachable");
      d.claim.release({ counted: true });
    }
    const aliceBlocked = claimDiscoverSlot({
      handle: "alice",
      isFreeHandle: false,
    });
    expect(aliceBlocked.allow).toBe(false);

    b1.claim.release({ counted: true });
    const bobOk = claimDiscoverSlot({ handle: "bob", isFreeHandle: false });
    expect(bobOk.allow).toBe(true);
  });

  it("__resetRateLimitState clears everything", () => {
    // Fill up alice's quota.
    for (let i = 0; i < 20; i++) {
      const d = claimDiscoverSlot({ handle: "alice", isFreeHandle: false });
      if (!d.allow) throw new Error("unreachable");
      d.claim.release({ counted: true });
    }
    const blocked = claimDiscoverSlot({
      handle: "alice",
      isFreeHandle: false,
    });
    expect(blocked.allow).toBe(false);

    // Leave a dangling in-flight claim too.
    const inflight = claimDiscoverSlot({
      handle: "bob",
      isFreeHandle: false,
    });
    expect(inflight.allow).toBe(true);

    __resetRateLimitState();

    // Alice's quota gone.
    const aliceOk = claimDiscoverSlot({
      handle: "alice",
      isFreeHandle: false,
    });
    expect(aliceOk.allow).toBe(true);

    // Bob's in-flight slot gone — a new claim should *not* abort bob's old
    // signal, because state was wiped. (Old signal stays un-aborted.)
    if (!inflight.allow) throw new Error("unreachable");
    const bobNew = claimDiscoverSlot({ handle: "bob", isFreeHandle: false });
    expect(bobNew.allow).toBe(true);
    expect(inflight.claim.signal.aborted).toBe(false);
  });

  it("handle is case-insensitive", () => {
    const first = claimDiscoverSlot({ handle: "Alice", isFreeHandle: false });
    expect(first.allow).toBe(true);
    if (!first.allow) throw new Error("unreachable");

    const second = claimDiscoverSlot({ handle: "alice", isFreeHandle: false });
    expect(second.allow).toBe(true);
    if (!second.allow) throw new Error("unreachable");
    // Same handle key → first should be preempted.
    expect(first.claim.signal.aborted).toBe(true);
  });

  it("release is idempotent", () => {
    const d = claimDiscoverSlot({ handle: "alice", isFreeHandle: false });
    expect(d.allow).toBe(true);
    if (!d.allow) throw new Error("unreachable");
    d.claim.release({ counted: true });
    // Second release with counted:true should NOT double-tick the quota.
    d.claim.release({ counted: true });

    // 19 more counted slots should still be available.
    for (let i = 0; i < 19; i++) {
      const next = claimDiscoverSlot({ handle: "alice", isFreeHandle: false });
      expect(next.allow).toBe(true);
      if (!next.allow) throw new Error("unreachable");
      next.claim.release({ counted: true });
    }
    const blocked = claimDiscoverSlot({
      handle: "alice",
      isFreeHandle: false,
    });
    expect(blocked.allow).toBe(false);
  });

  afterEach(() => {
    __resetRateLimitState();
  });
});

describe("claimCheapSlot", () => {
  beforeEach(() => {
    __resetRateLimitState();
  });

  afterEach(() => {
    __resetRateLimitState();
  });

  it("allows up to 60 completed calls per (handle, kind) per 5-min window", () => {
    for (let i = 0; i < 60; i++) {
      const d = claimCheapSlot({ handle: "alice", kind: "vector" });
      expect(d.allow).toBe(true);
      if (!d.allow) throw new Error("unreachable");
      d.release();
    }
    const blocked = claimCheapSlot({ handle: "alice", kind: "vector" });
    expect(blocked.allow).toBe(false);
    if (blocked.allow) throw new Error("unreachable");
    expect(blocked.reason).toBe("quota_exceeded");
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("different kinds share no state — vector and saved are independent buckets", () => {
    for (let i = 0; i < 60; i++) {
      const d = claimCheapSlot({ handle: "alice", kind: "vector" });
      expect(d.allow).toBe(true);
      if (!d.allow) throw new Error("unreachable");
      d.release();
    }
    // Vector is exhausted.
    const vBlocked = claimCheapSlot({ handle: "alice", kind: "vector" });
    expect(vBlocked.allow).toBe(false);

    // But saved is still wide open.
    const sOk = claimCheapSlot({ handle: "alice", kind: "saved" });
    expect(sOk.allow).toBe(true);
  });

  it("two different handles don't interfere on the same kind", () => {
    for (let i = 0; i < 60; i++) {
      const d = claimCheapSlot({ handle: "alice", kind: "vector" });
      if (!d.allow) throw new Error("unreachable");
      d.release();
    }
    const aliceBlocked = claimCheapSlot({ handle: "alice", kind: "vector" });
    expect(aliceBlocked.allow).toBe(false);

    const bobOk = claimCheapSlot({ handle: "bob", kind: "vector" });
    expect(bobOk.allow).toBe(true);
  });

  it("concurrency cap: 3 in-flight without release blocks the 4th with too_many_inflight", () => {
    const a = claimCheapSlot({ handle: "alice", kind: "vector" });
    const b = claimCheapSlot({ handle: "alice", kind: "vector" });
    const c = claimCheapSlot({ handle: "alice", kind: "vector" });
    expect(a.allow && b.allow && c.allow).toBe(true);

    const d = claimCheapSlot({ handle: "alice", kind: "vector" });
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error("unreachable");
    expect(d.reason).toBe("too_many_inflight");

    // Release one — slot opens up.
    if (a.allow) a.release();
    const e = claimCheapSlot({ handle: "alice", kind: "vector" });
    expect(e.allow).toBe(true);
  });

  it("handle is case-insensitive", () => {
    const d1 = claimCheapSlot({ handle: "Alice", kind: "vector" });
    expect(d1.allow).toBe(true);
    if (!d1.allow) throw new Error("unreachable");
    d1.release();

    // Same key — burn 59 more under lowercase.
    for (let i = 0; i < 59; i++) {
      const d = claimCheapSlot({ handle: "alice", kind: "vector" });
      if (!d.allow) throw new Error("unreachable");
      d.release();
    }
    const blocked = claimCheapSlot({ handle: "ALICE", kind: "vector" });
    expect(blocked.allow).toBe(false);
  });
});

describe("claimPhotoFetch", () => {
  beforeEach(() => {
    __resetRateLimitState();
  });

  afterEach(() => {
    __resetRateLimitState();
  });

  it("allows 100 fetches per 15-min window, blocks the 101st with retryAfter", () => {
    for (let i = 0; i < 100; i++) {
      const d = claimPhotoFetch("alice");
      expect(d.allow).toBe(true);
    }
    const blocked = claimPhotoFetch("alice");
    expect(blocked.allow).toBe(false);
    if (blocked.allow) throw new Error("unreachable");
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("two different handles don't interfere", () => {
    for (let i = 0; i < 100; i++) {
      const d = claimPhotoFetch("alice");
      expect(d.allow).toBe(true);
    }
    const aliceBlocked = claimPhotoFetch("alice");
    expect(aliceBlocked.allow).toBe(false);

    const bobOk = claimPhotoFetch("bob");
    expect(bobOk.allow).toBe(true);
  });

  it("handle is case-insensitive", () => {
    for (let i = 0; i < 100; i++) {
      const d = claimPhotoFetch("Alice");
      expect(d.allow).toBe(true);
    }
    const blocked = claimPhotoFetch("alice");
    expect(blocked.allow).toBe(false);
  });

  it("window slides — entries past 15 minutes age out", () => {
    vi.useFakeTimers();
    try {
      const start = new Date("2026-05-29T00:00:00Z").getTime();
      vi.setSystemTime(start);
      for (let i = 0; i < 100; i++) {
        const d = claimPhotoFetch("alice");
        expect(d.allow).toBe(true);
      }
      const blocked = claimPhotoFetch("alice");
      expect(blocked.allow).toBe(false);

      // Advance past 15min — first entries age out.
      vi.setSystemTime(start + 15 * 60 * 1000 + 1000);
      const ok = claimPhotoFetch("alice");
      expect(ok.allow).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
