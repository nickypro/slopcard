import { describe, it, expect, vi } from "vitest";

// Isolated SQLite file per test run — set DATA_DIR before the db module loads.
vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path");
  process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "slopcard-test-"));
});

import {
  countPendingLinkRequests,
  createPendingLinkRequest,
  decideLinkRequest,
  getLinkRequestById,
  getLinkRequestByToken,
  listLinkRequestsForHandle,
  listPendingLinkRequests,
} from "@/lib/db";

describe("createPendingLinkRequest", () => {
  it("round-trips an inserted request", () => {
    const { id, approveToken } = createPendingLinkRequest({
      handle: "alice",
      personId: "person-1",
      eventId: "ev",
      linkedName: "Alice A",
    });
    expect(id).toBeGreaterThan(0);
    expect(approveToken).toMatch(/^[0-9a-f]+$/);
    const row = getLinkRequestById(id);
    expect(row).not.toBeNull();
    expect(row!.handle).toBe("alice");
    expect(row!.personId).toBe("person-1");
    expect(row!.eventId).toBe("ev");
    expect(row!.linkedName).toBe("Alice A");
    expect(row!.state).toBe("pending");
    expect(row!.approveToken).toBe(approveToken);
    expect(typeof row!.requestedAt).toBe("number");
    expect(row!.decidedAt).toBeNull();
    expect(row!.decidedBy).toBeNull();
  });

  it("is idempotent: a second call for the same (handle, personId) returns the same id", () => {
    const first = createPendingLinkRequest({
      handle: "bob",
      personId: "person-bob",
      eventId: "ev",
      linkedName: "Bob B",
    });
    const second = createPendingLinkRequest({
      handle: "bob",
      personId: "person-bob",
      eventId: "ev",
      linkedName: "Bob Renamed",
    });
    expect(second.id).toBe(first.id);
    expect(second.approveToken).toBe(first.approveToken);
  });

  it("lowercases the handle on insert", () => {
    const { id } = createPendingLinkRequest({
      handle: "MixedCase",
      personId: "person-mc",
      eventId: "ev",
      linkedName: "Mixed Case",
    });
    expect(getLinkRequestById(id)!.handle).toBe("mixedcase");
  });

  it("after approval, a fresh pending request gets a NEW id", () => {
    const first = createPendingLinkRequest({
      handle: "carol",
      personId: "person-carol",
      eventId: "ev",
      linkedName: "Carol C",
    });
    decideLinkRequest(first.id, "approved", "admin");
    const second = createPendingLinkRequest({
      handle: "carol",
      personId: "person-carol",
      eventId: "ev",
      linkedName: "Carol C",
    });
    expect(second.id).not.toBe(first.id);
    expect(second.approveToken).not.toBe(first.approveToken);
  });

  it("after rejection, a fresh pending request gets a NEW id", () => {
    const first = createPendingLinkRequest({
      handle: "dave",
      personId: "person-dave",
      eventId: "ev",
      linkedName: "Dave D",
    });
    decideLinkRequest(first.id, "rejected", "admin");
    const second = createPendingLinkRequest({
      handle: "dave",
      personId: "person-dave",
      eventId: "ev",
      linkedName: "Dave D",
    });
    expect(second.id).not.toBe(first.id);
  });
});

describe("decideLinkRequest", () => {
  it("sets state, decided_at, decided_by", () => {
    const { id } = createPendingLinkRequest({
      handle: "eve",
      personId: "person-eve",
      eventId: "ev",
      linkedName: "Eve E",
    });
    const before = Date.now();
    const updated = decideLinkRequest(id, "approved", "admin");
    expect(updated).not.toBeNull();
    expect(updated!.state).toBe("approved");
    expect(updated!.decidedBy).toBe("admin");
    expect(updated!.decidedAt).not.toBeNull();
    expect(updated!.decidedAt!).toBeGreaterThanOrEqual(before);
  });

  it("returns null for an unknown id", () => {
    expect(decideLinkRequest(9_999_999, "approved", "admin")).toBeNull();
  });

  it("rejected state writes correctly", () => {
    const { id } = createPendingLinkRequest({
      handle: "frank",
      personId: "person-frank",
      eventId: "ev",
      linkedName: "Frank F",
    });
    const updated = decideLinkRequest(id, "rejected", "admin");
    expect(updated!.state).toBe("rejected");
  });
});

describe("getLinkRequestByToken", () => {
  it("finds the row by its approve_token", () => {
    const { id, approveToken } = createPendingLinkRequest({
      handle: "grace",
      personId: "person-grace",
      eventId: "ev",
      linkedName: "Grace G",
    });
    const row = getLinkRequestByToken(approveToken);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(id);
  });

  it("returns null for an unknown token", () => {
    expect(getLinkRequestByToken("nope")).toBeNull();
  });
});

describe("listPendingLinkRequests", () => {
  it("excludes approved and rejected rows", () => {
    const pendingOne = createPendingLinkRequest({
      handle: "hank",
      personId: "person-hank-pending",
      eventId: "ev",
      linkedName: "Hank",
    });
    const willApprove = createPendingLinkRequest({
      handle: "ivy",
      personId: "person-ivy-approve",
      eventId: "ev",
      linkedName: "Ivy",
    });
    const willReject = createPendingLinkRequest({
      handle: "jay",
      personId: "person-jay-reject",
      eventId: "ev",
      linkedName: "Jay",
    });
    decideLinkRequest(willApprove.id, "approved", "admin");
    decideLinkRequest(willReject.id, "rejected", "admin");

    const ids = listPendingLinkRequests().map((r) => r.id);
    expect(ids).toContain(pendingOne.id);
    expect(ids).not.toContain(willApprove.id);
    expect(ids).not.toContain(willReject.id);
  });

  it("orders by requested_at DESC", async () => {
    // Insert three rows with deliberate gaps so requested_at can't collide
    // within a single millisecond. The freshest should appear first.
    const first = createPendingLinkRequest({
      handle: "kara",
      personId: "person-order-1",
      eventId: "ev",
      linkedName: "K",
    });
    await new Promise((r) => setTimeout(r, 5));
    const second = createPendingLinkRequest({
      handle: "kara",
      personId: "person-order-2",
      eventId: "ev",
      linkedName: "K",
    });
    await new Promise((r) => setTimeout(r, 5));
    const third = createPendingLinkRequest({
      handle: "kara",
      personId: "person-order-3",
      eventId: "ev",
      linkedName: "K",
    });
    const rows = listPendingLinkRequests();
    const positionOf = (id: number) => rows.findIndex((r) => r.id === id);
    expect(positionOf(third.id)).toBeGreaterThanOrEqual(0);
    expect(positionOf(third.id)).toBeLessThan(positionOf(second.id));
    expect(positionOf(second.id)).toBeLessThan(positionOf(first.id));
  });
});

describe("listLinkRequestsForHandle", () => {
  it("returns rows for the handle, newest first, any state", async () => {
    const handle = "hist-user-1";
    const first = createPendingLinkRequest({
      handle,
      personId: "hist-p1",
      eventId: "ev",
      linkedName: "H1",
    });
    decideLinkRequest(first.id, "rejected", "admin");
    // Force monotonic timestamps so sort order is deterministic even on
    // hosts with low-resolution clocks.
    await new Promise((r) => setTimeout(r, 2));
    const second = createPendingLinkRequest({
      handle,
      personId: "hist-p2",
      eventId: "ev",
      linkedName: "H2",
    });
    await new Promise((r) => setTimeout(r, 2));
    const third = createPendingLinkRequest({
      handle,
      personId: "hist-p3",
      eventId: "ev",
      linkedName: "H3",
    });
    const rows = listLinkRequestsForHandle(handle);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
    expect(ids).toContain(third.id);
    expect(ids.indexOf(third.id)).toBeLessThan(ids.indexOf(second.id));
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    // Sanity: rejected row preserved with the right state.
    const rejected = rows.find((r) => r.id === first.id);
    expect(rejected!.state).toBe("rejected");
  });

  it("is case-insensitive on handle lookup", () => {
    const { id } = createPendingLinkRequest({
      handle: "MixedHist",
      personId: "case-p",
      eventId: "ev",
      linkedName: "M",
    });
    expect(listLinkRequestsForHandle("mixedhist").some((r) => r.id === id))
      .toBe(true);
    expect(listLinkRequestsForHandle("MIXEDHIST").some((r) => r.id === id))
      .toBe(true);
  });

  it("returns empty for unknown handles", () => {
    expect(listLinkRequestsForHandle("ghost-handle-9999")).toEqual([]);
  });

  it("respects the limit", () => {
    for (let i = 0; i < 6; i++) {
      createPendingLinkRequest({
        handle: "limited",
        personId: `lim-${i}`,
        eventId: "ev",
        linkedName: `L${i}`,
      });
    }
    expect(listLinkRequestsForHandle("limited", 3)).toHaveLength(3);
  });

  it("does not bleed across handles", () => {
    createPendingLinkRequest({
      handle: "alice-only",
      personId: "ao-p1",
      eventId: "ev",
      linkedName: "AO",
    });
    createPendingLinkRequest({
      handle: "bob-only",
      personId: "bo-p1",
      eventId: "ev",
      linkedName: "BO",
    });
    const aliceRows = listLinkRequestsForHandle("alice-only");
    expect(aliceRows.every((r) => r.handle === "alice-only")).toBe(true);
    expect(aliceRows.some((r) => r.linkedName === "AO")).toBe(true);
    expect(aliceRows.some((r) => r.linkedName === "BO")).toBe(false);
  });
});

describe("countPendingLinkRequests", () => {
  it("returns 0 when there are no pending rows", () => {
    // Approve everything else from prior tests so this run starts clean for
    // the count check. We can't truncate the table without dropping shared
    // state, so we decision-clear instead.
    const pending = listPendingLinkRequests();
    for (const r of pending) decideLinkRequest(r.id, "approved", "test");
    expect(countPendingLinkRequests()).toBe(0);
  });

  it("counts only state='pending' rows, not decided ones", () => {
    const a = createPendingLinkRequest({
      handle: "ct-a",
      personId: "ct-a1",
      eventId: "ev",
      linkedName: "A",
    });
    createPendingLinkRequest({
      handle: "ct-b",
      personId: "ct-b1",
      eventId: "ev",
      linkedName: "B",
    });
    createPendingLinkRequest({
      handle: "ct-c",
      personId: "ct-c1",
      eventId: "ev",
      linkedName: "C",
    });
    expect(countPendingLinkRequests()).toBe(3);
    decideLinkRequest(a.id, "approved", "admin");
    expect(countPendingLinkRequests()).toBe(2);
  });

  it("decided rows that get a fresh pending re-bump the count by 1", () => {
    // Same handle+person can re-request after being rejected — the new pending
    // row is a brand-new ID, so the count goes up.
    const { id } = createPendingLinkRequest({
      handle: "ct-rejoin",
      personId: "ct-rej-1",
      eventId: "ev",
      linkedName: "R",
    });
    const before = countPendingLinkRequests();
    decideLinkRequest(id, "rejected", "admin");
    expect(countPendingLinkRequests()).toBe(before - 1);
    createPendingLinkRequest({
      handle: "ct-rejoin",
      personId: "ct-rej-1",
      eventId: "ev",
      linkedName: "R",
    });
    expect(countPendingLinkRequests()).toBe(before);
  });
});

describe("approve_token uniqueness", () => {
  it("1000 inserts produce 1000 distinct tokens", () => {
    // The (handle, personId) pair has to differ each iteration so the
    // pending-idempotency index doesn't collapse them onto one row.
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const { approveToken } = createPendingLinkRequest({
        handle: "tok",
        personId: `tok-person-${i}`,
        eventId: "ev",
        linkedName: "T",
      });
      tokens.add(approveToken);
    }
    expect(tokens.size).toBe(1000);
  });
});
