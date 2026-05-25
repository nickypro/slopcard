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
