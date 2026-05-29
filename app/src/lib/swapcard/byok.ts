// Whitelist of handles that get to use the server-supplied OPENROUTER_API_KEY
// without paying out of pocket — typically just the slopcard owner. Anyone
// else has to bring their own key.
//
// Configured via env `SWAPCARD_FREE_HANDLES` (comma-separated, case-insensitive).
// Default empty → everyone is BYOK; safer to opt people in explicitly.

export function freeHandles(): Set<string> {
  const raw = process.env.SWAPCARD_FREE_HANDLES || "";
  return new Set(
    raw
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isFreeHandle(handle: string): boolean {
  return freeHandles().has(handle.toLowerCase());
}
