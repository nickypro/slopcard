// Parsing the user-pasted Swapcard profile URL into something we can match
// against the attendee dataset. Inputs come from the browser, so be strict:
// reject anything that isn't an `app.swapcard.com` link to `/event/<slug>/person/<id>`,
// and confirm the base64-decoded id has the `EventPeople_<digits>` shape Swapcard
// uses for attendees. This is the only verification step we have before granting
// access to /discover, so it's load-bearing.

export interface ParsedSwapcardUrl {
  eventSlug: string;
  personId: string; // the canonical base64 segment (e.g. "RXZlbnRQZW9wbGVfNDY0MTU0NzI=" or "Q29tbXVuaXR5UHJvZmlsZV80MzYyNjE")
  decoded: string; // "EventPeople_<digits>" or "CommunityProfile_<digits>"
  kind: "event_people" | "community_profile";
}

const ALLOWED_HOSTS = new Set(["app.swapcard.com", "www.swapcard.com"]);
// Both ID schemes Swapcard uses to identify the same person:
//   EventPeople_<n>      — event-scoped attendee record; what the Swapcard app
//                          shows in the URL bar when you click a person card.
//   CommunityProfile_<n> — global Swapcard community profile; what attendees
//                          self-reported when filling in the EAG sheet form.
// We accept either and match by the canonical base64 token, since the EAG
// sheet stores CommunityProfile links but users browsing the app see EventPeople.
const DECODED_RE = /^(EventPeople|CommunityProfile)_\d+$/;

function safeDecode(b64: string): string | null {
  try {
    // Normalize URL-safe variants and missing padding.
    const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
    const buf = Buffer.from(
      padded + "===".slice((padded.length + 3) % 4),
      "base64"
    );
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

export function parseSwapcardUrl(input: string): ParsedSwapcardUrl | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!ALLOWED_HOSTS.has(u.hostname)) return null;

  // /event/<slug>/person/<id>[/...]
  const parts = u.pathname.split("/").filter(Boolean);
  const eventIdx = parts.indexOf("event");
  const personIdx = parts.indexOf("person");
  if (eventIdx < 0 || personIdx < 0) return null;
  if (eventIdx + 1 >= parts.length || personIdx + 1 >= parts.length) return null;
  if (personIdx !== eventIdx + 2) return null; // must be event/<slug>/person/<id>

  const eventSlug = parts[eventIdx + 1];
  // u.pathname keeps percent-encoding intact, so a base64 id ending in `=`
  // arrives here as `…%3D` — `encodeURIComponent` is the standard way to
  // escape a base64 string in a URL path and we synthesize these for
  // sheet rows with blank Swapcard URLs (projectSearchRow fallback). Decode
  // before the strict-alphabet regex so we don't reject our own canonical
  // form. decodeURIComponent throws on malformed sequences — fail closed.
  let personId: string;
  try {
    personId = decodeURIComponent(parts[personIdx + 1]);
  } catch {
    return null;
  }

  // Canonicalize: strip trailing punctuation/queries Swapcard never emits but
  // a user might fat-finger when copying.
  if (!/^[A-Za-z0-9+/=_-]+$/.test(personId)) return null;
  const decoded = safeDecode(personId);
  if (!decoded) return null;
  const m = DECODED_RE.exec(decoded);
  if (!m) return null;
  const kind = m[1] === "EventPeople" ? "event_people" : "community_profile";

  return { eventSlug, personId, decoded, kind };
}

// Sheet-rendered LinkedIn URLs flow into `<a href>` on /discover. The public
// EAG sheet accepts arbitrary text in that column, so we re-validate at
// render time: must be linkedin.com (or a subdomain) on https. Anything
// else is treated as absent — the rec just shows no LinkedIn link.
const LINKEDIN_HOST_RE = /(^|\.)linkedin\.com$/;

export function isLinkedinUrl(input: string): boolean {
  if (!input || typeof input !== "string") return false;
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  return LINKEDIN_HOST_RE.test(u.hostname.toLowerCase());
}

// Same idea for Swapcard URLs — accept only if it parses as a real attendee
// profile link. Used as a guard before rendering sheet-sourced URLs in
// `<a href>`. (parseSwapcardUrl is the source of truth for the validation.)
export function isSwapcardProfileUrl(input: string): boolean {
  return parseSwapcardUrl(input) !== null;
}
