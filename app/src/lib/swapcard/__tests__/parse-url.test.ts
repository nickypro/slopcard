import { describe, it, expect } from "vitest";
import {
  isLinkedinUrl,
  isSwapcardProfileUrl,
  parseSwapcardUrl,
} from "@/lib/swapcard/parse-url";

// Pre-computed base64 tokens used across the suite. Keeping them as constants
// (rather than re-encoding inline) makes intent obvious when reading a failure.
const EVENT_PEOPLE_TOKEN = "RXZlbnRQZW9wbGVfNDY0MTU0NzI="; // EventPeople_46415472
const EVENT_PEOPLE_TOKEN_UNPADDED = "RXZlbnRQZW9wbGVfNDY0MTU0NzI"; // URL-safe / no padding
const COMMUNITY_PROFILE_TOKEN = "Q29tbXVuaXR5UHJvZmlsZV80MzYyNjEyNg=="; // CommunityProfile_43626126
const EXHIBITOR_TOKEN = "RXhoaWJpdG9yXzEyMzQ1"; // Exhibitor_12345

describe("parseSwapcardUrl", () => {
  it("parses a valid EventPeople_<n> URL", () => {
    const url = `https://app.swapcard.com/event/eag-london-2026/person/${EVENT_PEOPLE_TOKEN}`;
    const result = parseSwapcardUrl(url);
    expect(result).not.toBeNull();
    expect(result?.eventSlug).toBe("eag-london-2026");
    expect(result?.personId).toBe(EVENT_PEOPLE_TOKEN);
    expect(result?.decoded).toBe("EventPeople_46415472");
    expect(result?.kind).toBe("event_people");
  });

  it("parses a valid CommunityProfile_<n> URL", () => {
    const url = `https://app.swapcard.com/event/some-event/person/${COMMUNITY_PROFILE_TOKEN}`;
    const result = parseSwapcardUrl(url);
    expect(result).not.toBeNull();
    expect(result?.eventSlug).toBe("some-event");
    expect(result?.personId).toBe(COMMUNITY_PROFILE_TOKEN);
    expect(result?.decoded).toBe("CommunityProfile_43626126");
    expect(result?.kind).toBe("community_profile");
  });

  it("accepts www.swapcard.com as a host", () => {
    const url = `https://www.swapcard.com/event/foo/person/${EVENT_PEOPLE_TOKEN}`;
    expect(parseSwapcardUrl(url)).not.toBeNull();
  });

  it("rejects non-app.swapcard.com hosts", () => {
    expect(
      parseSwapcardUrl(
        `https://swapcard.com/event/foo/person/${EVENT_PEOPLE_TOKEN}`
      )
    ).toBeNull();
    expect(
      parseSwapcardUrl(
        `https://evil.com/event/foo/person/${EVENT_PEOPLE_TOKEN}`
      )
    ).toBeNull();
    expect(
      parseSwapcardUrl(
        `https://app.swapcard.evil.com/event/foo/person/${EVENT_PEOPLE_TOKEN}`
      )
    ).toBeNull();
  });

  it("rejects URLs whose personId is malformed base64 (illegal characters)", () => {
    // `!` isn't in the [A-Za-z0-9+/=_-] charset, so the pre-decode regex
    // rejects this before we even reach the base64 decoder.
    const url = "https://app.swapcard.com/event/foo/person/not!valid";
    expect(parseSwapcardUrl(url)).toBeNull();
  });

  it("rejects base64 that decodes to something other than EventPeople/CommunityProfile", () => {
    // Valid base64 with valid charset, decodes to "Exhibitor_12345".
    const url = `https://app.swapcard.com/event/foo/person/${EXHIBITOR_TOKEN}`;
    expect(parseSwapcardUrl(url)).toBeNull();
  });

  it("rejects base64 that decodes to garbage", () => {
    // Valid base64 charset but garbage payload.
    const garbage = Buffer.from("hello world").toString("base64");
    const url = `https://app.swapcard.com/event/foo/person/${garbage}`;
    expect(parseSwapcardUrl(url)).toBeNull();
  });

  it("rejects URLs without /event/<slug>/person/<id> shape", () => {
    expect(parseSwapcardUrl("https://app.swapcard.com/")).toBeNull();
    expect(parseSwapcardUrl("https://app.swapcard.com/event/foo")).toBeNull();
    expect(
      parseSwapcardUrl("https://app.swapcard.com/person/" + EVENT_PEOPLE_TOKEN)
    ).toBeNull();
    // event and person present but not adjacent
    expect(
      parseSwapcardUrl(
        `https://app.swapcard.com/event/foo/something/person/${EVENT_PEOPLE_TOKEN}`
      )
    ).toBeNull();
    // missing the trailing id
    expect(
      parseSwapcardUrl(`https://app.swapcard.com/event/foo/person/`)
    ).toBeNull();
  });

  it("rejects exhibitor-style links (decoded prefix doesn't match)", () => {
    // app.swapcard.com sometimes serves /event/<slug>/exhibitor/<id>; even
    // if a user munges that into a /person/ path the decoded id starts with
    // "Exhibitor_" and gets rejected by DECODED_RE.
    const url = `https://app.swapcard.com/event/foo/person/${EXHIBITOR_TOKEN}`;
    expect(parseSwapcardUrl(url)).toBeNull();
  });

  it("trims whitespace from the input", () => {
    const url = `   https://app.swapcard.com/event/foo/person/${EVENT_PEOPLE_TOKEN}\n`;
    const result = parseSwapcardUrl(url);
    expect(result?.decoded).toBe("EventPeople_46415472");
  });

  it("handles URL-safe base64 (missing padding, _ and -)", () => {
    // Same payload as EVENT_PEOPLE_TOKEN but with the trailing = stripped —
    // which is what URL-safe base64 emitters typically produce.
    const url = `https://app.swapcard.com/event/foo/person/${EVENT_PEOPLE_TOKEN_UNPADDED}`;
    const result = parseSwapcardUrl(url);
    expect(result?.decoded).toBe("EventPeople_46415472");
    expect(result?.personId).toBe(EVENT_PEOPLE_TOKEN_UNPADDED);
  });

  it("rejects non-URL strings", () => {
    expect(parseSwapcardUrl("not a url")).toBeNull();
    expect(parseSwapcardUrl("")).toBeNull();
  });

  it("rejects non-http(s) protocols", () => {
    expect(
      parseSwapcardUrl(
        `ftp://app.swapcard.com/event/foo/person/${EVENT_PEOPLE_TOKEN}`
      )
    ).toBeNull();
  });

  // The projectSearchRow fallback synthesizes URLs using
  // encodeURIComponent(event_people_id). Base64 ids end in `=`, which gets
  // escaped to `%3D` in the path — the validator must decode before checking
  // the strict alphabet regex, or our own synthesized URLs come back as
  // "not a valid profile URL" and the /people row drops its link.
  it("accepts percent-encoded base64 padding (our own synthesized fallback URL)", () => {
    const encoded = encodeURIComponent(EVENT_PEOPLE_TOKEN);
    expect(encoded).toContain("%3D");
    const url = `https://app.swapcard.com/event/eag-london/person/${encoded}`;
    const result = parseSwapcardUrl(url);
    expect(result).not.toBeNull();
    expect(result?.personId).toBe(EVENT_PEOPLE_TOKEN);
    expect(result?.kind).toBe("event_people");
  });

  it("accepts a CommunityProfile id with percent-encoded `==` padding", () => {
    const encoded = encodeURIComponent(COMMUNITY_PROFILE_TOKEN);
    expect(encoded).toContain("%3D%3D");
    const url = `https://app.swapcard.com/event/foo/person/${encoded}`;
    const r = parseSwapcardUrl(url);
    expect(r).not.toBeNull();
    expect(r?.kind).toBe("community_profile");
  });

  it("rejects malformed percent escapes (fail closed)", () => {
    // "%E0" alone is incomplete; decodeURIComponent throws → return null.
    expect(
      parseSwapcardUrl("https://app.swapcard.com/event/foo/person/%E0")
    ).toBeNull();
  });
});

describe("isLinkedinUrl", () => {
  it("accepts canonical linkedin.com URLs", () => {
    expect(isLinkedinUrl("https://www.linkedin.com/in/nickyp")).toBe(true);
    expect(isLinkedinUrl("https://linkedin.com/in/nickyp")).toBe(true);
    expect(isLinkedinUrl("https://uk.linkedin.com/in/someone")).toBe(true);
    expect(isLinkedinUrl(" https://linkedin.com/in/foo  ")).toBe(true);
  });

  it("rejects phishing lookalikes", () => {
    expect(isLinkedinUrl("https://linkedin.com.evil.io/in/foo")).toBe(false);
    expect(isLinkedinUrl("https://linkedln.com/in/foo")).toBe(false);
    expect(isLinkedinUrl("https://l1nkedin.com/in/foo")).toBe(false);
    expect(isLinkedinUrl("https://evil.com/?u=linkedin.com")).toBe(false);
  });

  it("rejects non-http(s) and malformed", () => {
    expect(isLinkedinUrl("javascript:alert(1)")).toBe(false);
    expect(isLinkedinUrl("data:text/html,<script>")).toBe(false);
    expect(isLinkedinUrl("not a url")).toBe(false);
    expect(isLinkedinUrl("")).toBe(false);
    expect(isLinkedinUrl("   ")).toBe(false);
  });
});

describe("isSwapcardProfileUrl", () => {
  it("returns true for the same URLs parseSwapcardUrl accepts", () => {
    expect(
      isSwapcardProfileUrl(
        `https://app.swapcard.com/event/eag-london/person/${EVENT_PEOPLE_TOKEN}`
      )
    ).toBe(true);
    expect(
      isSwapcardProfileUrl(
        `https://app.swapcard.com/event/foo/person/${COMMUNITY_PROFILE_TOKEN}`
      )
    ).toBe(true);
  });

  it("rejects URLs that look phishy", () => {
    expect(isSwapcardProfileUrl("https://evil.com/event/x/person/y")).toBe(
      false
    );
    expect(
      isSwapcardProfileUrl(
        `https://app.swapcard.com.evil.io/event/foo/person/${EVENT_PEOPLE_TOKEN}`
      )
    ).toBe(false);
    expect(
      isSwapcardProfileUrl(
        `https://app.swapcard.com/event/foo/person/${EXHIBITOR_TOKEN}`
      )
    ).toBe(false);
    expect(isSwapcardProfileUrl("javascript:alert(1)")).toBe(false);
    expect(isSwapcardProfileUrl("")).toBe(false);
  });
});
