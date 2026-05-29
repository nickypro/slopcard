import { describe, it, expect } from "vitest";
import { classifyDiscoverError, newErrId } from "@/lib/swapcard/error-classifier";

describe("classifyDiscoverError", () => {
  it("maps missing-key errors to a key-config message", () => {
    expect(classifyDiscoverError("OPENROUTER_API_KEY not set")).toMatch(
      /openrouter key not configured/i
    );
  });

  it("maps OpenRouter 401 to a key-invalid hint", () => {
    expect(
      classifyDiscoverError("LLM call failed (401): invalid api key")
    ).toMatch(/rejected the key/i);
  });

  it("maps OpenRouter 402 / insufficient-credit to a topup hint", () => {
    expect(
      classifyDiscoverError("LLM call failed (402): insufficient credit")
    ).toMatch(/insufficient credit/i);
  });

  it("maps OpenRouter 429 to a rate-limit hint", () => {
    expect(classifyDiscoverError("LLM call failed (429): rate limit")).toMatch(
      /rate limit/i
    );
  });

  it("maps OpenRouter 5xx to an upstream message", () => {
    expect(classifyDiscoverError("LLM call failed (502): bad gateway")).toMatch(
      /upstream/i
    );
  });

  it("maps unparseable LLM output to a JSON hint", () => {
    expect(
      classifyDiscoverError(
        "Could not parse LLM JSON. First 300 chars of output: {foo"
      )
    ).toMatch(/malformed json/i);
  });

  it("maps cache-empty errors to an ingest hint", () => {
    expect(
      classifyDiscoverError("No attendee data ingested for this event yet")
    ).toMatch(/dataset isn't loaded/i);
  });

  it("maps aborts to a clear preempted message", () => {
    expect(classifyDiscoverError("The operation was aborted")).toMatch(
      /aborted/i
    );
  });

  it("does not leak the raw input back to the user", () => {
    const raw =
      "Could not parse LLM JSON. First 300 chars of output: my-secret-bio";
    const out = classifyDiscoverError(raw);
    expect(out).not.toContain("my-secret-bio");
  });

  it("falls back to a generic message for unrecognised errors", () => {
    expect(classifyDiscoverError("totally unexpected weirdness")).toMatch(
      /check server logs/i
    );
  });

  describe("network/transport bucket", () => {
    // The default Node fetch failure message is "fetch failed" with no status;
    // we need a dedicated bucket so the user doesn't get the generic fallback.
    it("maps bare 'fetch failed' to a network-reachability hint", () => {
      const out = classifyDiscoverError("fetch failed");
      expect(out).toMatch(/couldn't reach OpenRouter/i);
      expect(out).toMatch(/network error/i);
    });

    it("maps DNS lookup failures to the network bucket", () => {
      expect(
        classifyDiscoverError("getaddrinfo ENOTFOUND openrouter.ai")
      ).toMatch(/couldn't reach OpenRouter/i);
    });

    it("maps connection refused / reset / timeout to the network bucket", () => {
      expect(classifyDiscoverError("ECONNREFUSED 1.2.3.4:443")).toMatch(
        /couldn't reach OpenRouter/i
      );
      expect(classifyDiscoverError("read ECONNRESET")).toMatch(
        /couldn't reach OpenRouter/i
      );
      expect(classifyDiscoverError("connect ETIMEDOUT")).toMatch(
        /couldn't reach OpenRouter/i
      );
      expect(classifyDiscoverError("socket hang up")).toMatch(
        /couldn't reach OpenRouter/i
      );
    });

    it("does NOT swallow 4xx into the network bucket", () => {
      // 401 path should still win over any incidental keyword overlap.
      expect(
        classifyDiscoverError("LLM call failed (401): fetch failed reads")
      ).toMatch(/rejected the key/i);
    });
  });

  describe("errId tagging", () => {
    it("appends [err:XXX] when an errId is supplied", () => {
      const out = classifyDiscoverError("fetch failed", "ab12cd");
      expect(out).toMatch(/\[err:ab12cd\]$/);
    });

    it("omits the tag when no errId is supplied", () => {
      const out = classifyDiscoverError("fetch failed");
      expect(out).not.toMatch(/\[err:/);
    });

    it("produces the same user-facing prefix for owner and BYOK paths", () => {
      // Behaviour-consistency check: same raw error from either user produces
      // the same bucket category (only the errId differs).
      const ownerErr = classifyDiscoverError("LLM call failed (401): invalid", "aaa111");
      const byokErr = classifyDiscoverError("LLM call failed (401): invalid", "bbb222");
      const stripTail = (s: string) => s.replace(/ \[err:[a-f0-9]+\]$/, "");
      expect(stripTail(ownerErr)).toBe(stripTail(byokErr));
    });
  });

  describe("newErrId", () => {
    it("returns a short hex token", () => {
      const id = newErrId();
      expect(id).toMatch(/^[a-f0-9]{6}$/);
    });

    it("does not collide across many invocations", () => {
      // Birthday-bound across 24 bits is ~16M, so 1000 samples should be
      // unique with overwhelming probability.
      const ids = new Set<string>();
      for (let i = 0; i < 1000; i++) ids.add(newErrId());
      expect(ids.size).toBe(1000);
    });
  });
});
