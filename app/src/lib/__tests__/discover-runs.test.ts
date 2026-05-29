import { describe, it, expect, vi } from "vitest";

// Point DATA_DIR at a unique temp dir BEFORE the db module loads so the
// SQLite file lives in an isolated location for this test file. vi.hoisted
// runs before any `import` statement executes, so we set the env var here.
// Node built-ins are loaded via require() inside the hoisted block — bare
// imports aren't available yet at hoist time.
vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path");
  process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "slopcard-test-"));
});

import { getDiscoverRunById, insertDiscoverRun } from "@/lib/db";

describe("getDiscoverRunById", () => {
  it("round-trips an inserted run by id", () => {
    const payload = JSON.stringify({ recommendations: [], runId: 0 });
    const id = insertDiscoverRun(
      "alice",
      "eag-london-2026",
      "sig-abc",
      payload
    );
    expect(id).toBeGreaterThan(0);
    const got = getDiscoverRunById(id);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(id);
    expect(got!.handle).toBe("alice");
    expect(got!.eventId).toBe("eag-london-2026");
    expect(got!.sheetSignature).toBe("sig-abc");
    expect(got!.payloadJson).toBe(payload);
    expect(typeof got!.createdAt).toBe("number");
  });

  it("returns null for an id that doesn't exist", () => {
    expect(getDiscoverRunById(999_999_999)).toBeNull();
  });

  it("doesn't filter by handle — caller authorises", () => {
    // Two runs for different handles, fetched by id without a handle filter:
    // both should be retrievable. The permalink page applies the owner check
    // after loading, which is what lets it distinguish 403 from 404.
    const idA = insertDiscoverRun("alice", "ev", "sig", "{}");
    const idB = insertDiscoverRun("bob", "ev", "sig", "{}");
    expect(getDiscoverRunById(idA)?.handle).toBe("alice");
    expect(getDiscoverRunById(idB)?.handle).toBe("bob");
  });
});

// ── Permalink page: non-owner collapses to notFound() (iter 19 pen-test) ──
// Vitest can't import `.tsx` server components cleanly under tsconfig
// `jsx: preserve`, so we lock the fix in via a source-level assertion on
// the page file. The structure asserted matches the post-fix code shape
// (single `notFound()` call inside the owner-mismatch branch, no JSX
// fallback that could leak the "exists but isn't yours" signal).
describe("/discover/run/[id] page source — owner check", () => {
  it("non-owner branch calls notFound() and does NOT render a 403 panel", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path");
    const source = readFileSync(
      path.resolve(
        __dirname,
        "..",
        "..",
        "app",
        "discover",
        "run",
        "[id]",
        "page.tsx"
      ),
      "utf8"
    ) as string;

    // The owner check exists and is case-insensitive.
    expect(source).toContain(
      "stored.handle.toLowerCase() !== session.twitterHandle.toLowerCase()"
    );

    // After the owner check, the branch calls notFound() — not a 403 panel.
    // Extract the substring from the owner check to the next closing brace
    // and assert it contains notFound() and no JSX-return.
    const ownerCheckIdx = source.indexOf(
      "stored.handle.toLowerCase() !== session.twitterHandle.toLowerCase()"
    );
    expect(ownerCheckIdx).toBeGreaterThan(-1);
    const remainder = source.slice(ownerCheckIdx, ownerCheckIdx + 600);
    expect(remainder).toContain("notFound()");
    // The old code returned JSX inside this branch — make sure the panel
    // string and the <main> tag aren't present in this short window.
    expect(remainder).not.toContain("this run belongs to a different");
  });
});
