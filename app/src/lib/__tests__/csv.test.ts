import { describe, expect, it } from "vitest";
import { csvCell, serializeCsv } from "@/lib/csv";

describe("csvCell", () => {
  it("returns empty string for null and undefined", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("passes simple strings through unchanged", () => {
    expect(csvCell("hello")).toBe("hello");
    expect(csvCell("Anthropic")).toBe("Anthropic");
  });

  it("wraps values containing commas in double quotes", () => {
    expect(csvCell("hello, world")).toBe('"hello, world"');
  });

  it("wraps values containing newlines in double quotes", () => {
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("a\rb")).toBe('"a\rb"');
  });

  it("doubles internal double-quotes and wraps the value (RFC 4180)", () => {
    expect(csvCell('she said "hi"')).toBe('"she said ""hi"""');
  });

  it("coerces numbers to their string form", () => {
    expect(csvCell(0)).toBe("0");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(-1.5)).toBe("-1.5");
  });
});

describe("serializeCsv", () => {
  it("emits the header row in the column order requested", () => {
    const csv = serializeCsv([], ["a", "b", "c"]);
    // Strip BOM + trailing CRLF for the assertion.
    expect(csv.replace(/^﻿/, "").trimEnd()).toBe("a,b,c");
  });

  it("emits one row per input record in column order", () => {
    const out = serializeCsv(
      [
        { name: "Alice", role: "Eng" },
        { name: "Bob", role: "PM" },
      ],
      ["name", "role"]
    );
    const lines = out.replace(/^﻿/, "").trimEnd().split("\r\n");
    expect(lines).toEqual(["name,role", "Alice,Eng", "Bob,PM"]);
  });

  it("uses CRLF line endings and prepends a UTF-8 BOM", () => {
    const out = serializeCsv([{ a: "x" }], ["a"]);
    expect(out.startsWith("﻿")).toBe(true);
    expect(out.includes("\r\n")).toBe(true);
  });

  it("escapes cells that contain delimiters / quotes / newlines", () => {
    const out = serializeCsv(
      [{ a: "hello, world", b: 'a "quote"', c: "line\nbreak" }],
      ["a", "b", "c"]
    );
    const body = out.replace(/^﻿/, "").trimEnd().split("\r\n")[1];
    expect(body).toBe('"hello, world","a ""quote""","line\nbreak"');
  });

  it("treats null/undefined values as empty cells", () => {
    const out = serializeCsv(
      [{ a: null, b: undefined, c: "x" }],
      ["a", "b", "c"]
    );
    const body = out.replace(/^﻿/, "").trimEnd().split("\r\n")[1];
    expect(body).toBe(",,x");
  });

  it("preserves diacritics and non-ASCII characters verbatim", () => {
    // José García-López, etc. — Excel uses the BOM to pick the right page.
    const out = serializeCsv(
      [{ name: "José García-López", note: "café ☕" }],
      ["name", "note"]
    );
    const body = out.replace(/^﻿/, "").trimEnd().split("\r\n")[1];
    expect(body).toBe("José García-López,café ☕");
  });

  it("flattens non-string non-number cells via String()", () => {
    const out = serializeCsv(
      [{ a: true, b: { foo: 1 } } as Record<string, unknown>],
      ["a", "b"]
    );
    const body = out.replace(/^﻿/, "").trimEnd().split("\r\n")[1];
    // booleans → "true" / "false". objects → "[object Object]" (acceptable
    // because the saved-export path never hits this branch in practice).
    expect(body).toBe("true,[object Object]");
  });
});
