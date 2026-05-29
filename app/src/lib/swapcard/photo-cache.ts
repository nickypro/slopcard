import path from "node:path";

// Server-side photo cache for Swapcard attendee avatars. Swapcard rotates
// upstream CDN URLs (the `photo_url` we stored at scrape time can 404 weeks
// later), so we proxy + persist the bytes the first time a discover run
// references each personId. Subsequent loads serve from disk.

// Sanitise an arbitrary personId into a filesystem-safe segment. Swapcard
// IDs are base64 of `EventPeople_<n>` / `CommunityProfile_<n>` so in practice
// the alphabet is `[A-Za-z0-9+/=_-]` — but we replace anything outside
// `[A-Za-z0-9_-]` with `_` defensively (no `/`, no path-traversal `..`, no
// shell metacharacters).
export function sanitizePersonId(personId: string): string {
  return personId.replace(/[^A-Za-z0-9_-]/g, "_");
}

// Resolve the on-disk cache file for a given (eventId, personId). The eventId
// is also sanitised so an attacker-controlled SWAPCARD_EVENT_ID couldn't
// traverse out of the photos dir (in practice env-controlled, but cheap).
export function cachePathFor(
  cacheDir: string,
  eventId: string,
  personId: string
): string {
  const safeEvent = sanitizePersonId(eventId);
  const safePerson = sanitizePersonId(personId);
  return path.join(cacheDir, `${safeEvent}__${safePerson}.bin`);
}

// Default cache dir: <DATA_DIR>/photos. Lives alongside the sqlite db so a
// volume-mounted /app/data captures both in one snapshot.
export function defaultCacheDir(): string {
  const dataDir = process.env.DATA_DIR || "/app/data";
  return path.join(dataDir, "photos");
}
