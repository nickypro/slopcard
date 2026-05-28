const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

const RESERVED = new Set([
  "api",
  "admin",
  "pending",
  "thanks",
  "card",
  "submit",
  "_next",
  "favicon",
  "robots",
  "sitemap",
  "static",
]);

export function normalizeHandle(input: string): string {
  return input.replace(/^@/, "").trim().toLowerCase();
}

export function isValidHandle(h: string): boolean {
  if (!HANDLE_RE.test(h)) return false;
  if (RESERVED.has(h.toLowerCase())) return false;
  return true;
}

export function isValidSwapcardUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

// Keep author-intended newlines (single line break, blank line) but collapse
// runs of 3+ consecutive newlines down to 2 so a card can't be stretched
// into an absurd vertical wall. Also trims trailing whitespace.
export function normalizeBio(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
