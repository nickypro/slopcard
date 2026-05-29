import { describe, it, expect } from "vitest";
import { normalizeName } from "@/lib/swapcard/scrape-attendees";

describe("normalizeName", () => {
  it("lowercases ASCII input", () => {
    expect(normalizeName("Alice Smith")).toBe("alice smith");
  });

  it("strips diacritics", () => {
    expect(normalizeName("José García")).toBe("jose garcia");
    expect(normalizeName("François Müller")).toBe("francois muller");
    expect(normalizeName("Ångström")).toBe("angstrom");
  });

  it("collapses multiple spaces", () => {
    expect(normalizeName("Alice    Smith")).toBe("alice smith");
    expect(normalizeName("a  b   c")).toBe("a b c");
  });

  it("drops common punctuation, replacing with space", () => {
    expect(normalizeName("O'Brien")).toBe("o brien");
    expect(normalizeName("Anne-Marie")).toBe("anne marie");
    expect(normalizeName("Smith, Jr.")).toBe("smith jr");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeName("   Alice   ")).toBe("alice");
    expect(normalizeName("\tBob\n")).toBe("bob");
  });

  it("handles empty string", () => {
    expect(normalizeName("")).toBe("");
  });

  it("handles whitespace-only input", () => {
    expect(normalizeName("   \t\n")).toBe("");
  });

  it("handles combined diacritics + punctuation + whitespace", () => {
    expect(normalizeName("  José-María  O'Connor  ")).toBe(
      "jose maria o connor"
    );
  });

  it("preserves digits", () => {
    expect(normalizeName("Agent 007")).toBe("agent 007");
  });

  it("strips diacritics on hyphenated names", () => {
    expect(normalizeName("García-López")).toBe("garcia lopez");
  });
});
