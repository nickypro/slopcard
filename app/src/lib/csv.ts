// Minimal CSV serialization helpers. Used by /saved's "export CSV ↓" button
// to roll up the user's bookmarked attendees + per-bookmark notes (both
// localStorage-only) into a portable file at conference end.
//
// Dialect choices match what Excel and Google Sheets auto-detect when you
// double-click a .csv:
//   - cells with `,`, `"`, `\n`, or `\r` get wrapped in double-quotes
//   - internal `"` doubled (RFC 4180)
//   - CRLF line endings (Excel is fussy about LF on Windows)
//   - UTF-8 BOM prepended so non-ASCII (diacritics, emoji) don't mojibake
//     when Excel opens the file with its default code page.

export function csvCell(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return "";
  const str = String(s);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Serialize an array-of-objects to a CSV string. `columns` declares the
// header order; only those keys are emitted. Missing keys serialize as
// empty cells (csvCell handles null/undefined).
export function serializeCsv<T extends Record<string, unknown>>(
  rows: T[],
  columns: (keyof T & string)[]
): string {
  const lines: string[] = [columns.join(",")];
  for (const row of rows) {
    const cells = columns.map((col) => {
      const v = row[col];
      if (typeof v === "string" || typeof v === "number") return csvCell(v);
      if (v === null || v === undefined) return "";
      // Defensive: anything else (boolean, object) flattens to its String
      // form. We don't expect this in the saved-export path but keep the
      // helper general-purpose.
      return csvCell(String(v));
    });
    lines.push(cells.join(","));
  }
  // BOM + CRLF — see header comment for rationale.
  return "﻿" + lines.join("\r\n") + "\r\n";
}
