import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { freeHandles, isFreeHandle } from "@/lib/swapcard/byok";

describe("freeHandles / isFreeHandle", () => {
  beforeEach(() => {
    vi.stubEnv("SWAPCARD_FREE_HANDLES", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns an empty set when the env var is unset", () => {
    vi.unstubAllEnvs();
    // Some test runners may inherit a value; force-unset to be safe.
    vi.stubEnv("SWAPCARD_FREE_HANDLES", "");
    expect(freeHandles()).toEqual(new Set());
    expect(isFreeHandle("anyone")).toBe(false);
  });

  it("parses comma-separated values", () => {
    vi.stubEnv("SWAPCARD_FREE_HANDLES", "alice,bob,carol");
    expect(freeHandles()).toEqual(new Set(["alice", "bob", "carol"]));
  });

  it("is case-insensitive on both env values and queries", () => {
    vi.stubEnv("SWAPCARD_FREE_HANDLES", "Alice,BOB");
    expect(freeHandles()).toEqual(new Set(["alice", "bob"]));
    expect(isFreeHandle("alice")).toBe(true);
    expect(isFreeHandle("ALICE")).toBe(true);
    expect(isFreeHandle("Bob")).toBe(true);
    expect(isFreeHandle("carol")).toBe(false);
  });

  it("trims whitespace around individual entries", () => {
    vi.stubEnv("SWAPCARD_FREE_HANDLES", "  alice  ,  bob  ,carol");
    expect(freeHandles()).toEqual(new Set(["alice", "bob", "carol"]));
    expect(isFreeHandle("alice")).toBe(true);
  });

  it("drops empty entries from a trailing/leading/double comma", () => {
    vi.stubEnv("SWAPCARD_FREE_HANDLES", ",alice,,bob,");
    expect(freeHandles()).toEqual(new Set(["alice", "bob"]));
  });

  it("a single handle still works", () => {
    vi.stubEnv("SWAPCARD_FREE_HANDLES", "only");
    expect(freeHandles()).toEqual(new Set(["only"]));
    expect(isFreeHandle("only")).toBe(true);
  });

  it("empty string means no free handles", () => {
    vi.stubEnv("SWAPCARD_FREE_HANDLES", "");
    expect(freeHandles().size).toBe(0);
    expect(isFreeHandle("alice")).toBe(false);
  });
});
