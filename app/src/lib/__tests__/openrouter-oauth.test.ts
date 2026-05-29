import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import {
  buildAuthorizeUrl,
  exchangeCode,
  getCallbackUrl,
  makePkce,
  makeState,
} from "@/lib/openrouter";
import { __test__openRouterCookieCodec, __test__openRouterPkceCodec } from "@/lib/session";

function b64urlOf(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("openrouter PKCE helpers", () => {
  it("makePkce produces a verifier in the RFC 7636 length window", () => {
    const { verifier, challenge } = makePkce();
    // 64 random bytes base64url'd = 86 chars (no padding). Spec allows 43-128.
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    // base64url alphabet only
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("makePkce challenge is the S256 hash of the verifier", () => {
    const { verifier, challenge } = makePkce();
    const expected = b64urlOf(
      crypto.createHash("sha256").update(verifier).digest()
    );
    expect(challenge).toBe(expected);
  });

  it("makePkce yields fresh verifiers across calls", () => {
    const a = makePkce();
    const b = makePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });

  it("makeState returns base64url and is non-empty", () => {
    const s = makeState();
    expect(s.length).toBeGreaterThan(20);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("buildAuthorizeUrl / getCallbackUrl", () => {
  beforeEach(() => {
    vi.stubEnv("SITE_URL", "https://slopcard.org");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("getCallbackUrl points at the callback route under SITE_URL", () => {
    expect(getCallbackUrl()).toBe(
      "https://slopcard.org/api/auth/openrouter/callback"
    );
  });

  it("getCallbackUrl trims a trailing slash on SITE_URL", () => {
    vi.stubEnv("SITE_URL", "https://slopcard.org/");
    expect(getCallbackUrl()).toBe(
      "https://slopcard.org/api/auth/openrouter/callback"
    );
  });

  it("getCallbackUrl falls back to localhost when SITE_URL is unset", () => {
    vi.unstubAllEnvs();
    expect(getCallbackUrl()).toBe(
      "http://localhost:3000/api/auth/openrouter/callback"
    );
  });

  it("buildAuthorizeUrl includes callback_url, S256 challenge and method", () => {
    const u = new URL(buildAuthorizeUrl("CHAL_123"));
    expect(u.origin + u.pathname).toBe("https://openrouter.ai/auth");
    expect(u.searchParams.get("callback_url")).toBe(
      "https://slopcard.org/api/auth/openrouter/callback"
    );
    expect(u.searchParams.get("code_challenge")).toBe("CHAL_123");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("exchangeCode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs the documented JSON shape to /api/v1/auth/keys", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ key: "sk-or-v1-test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );

    const result = await exchangeCode("CODE_ABC", "VER_XYZ");
    expect(result).toEqual({ key: "sk-or-v1-test" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/auth/keys");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      code: "CODE_ABC",
      code_verifier: "VER_XYZ",
      code_challenge_method: "S256",
    });
  });

  it("returns null when OpenRouter responds non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 400 })
    );
    expect(await exchangeCode("c", "v")).toBeNull();
  });

  it("returns null when the response body lacks a `key` field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ not_key: "x" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    expect(await exchangeCode("c", "v")).toBeNull();
  });

  it("returns null when `key` is empty", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ key: "" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    expect(await exchangeCode("c", "v")).toBeNull();
  });
});

describe("OpenRouter cookie codec (round-trip)", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "test-secret-for-cookie-roundtrip");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("encodes then decodes back to the original payload", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const encoded = __test__openRouterCookieCodec.encode({
      key: "sk-or-v1-abcdef",
      exp,
    });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const decoded = __test__openRouterCookieCodec.decode(encoded);
    expect(decoded).toEqual({ key: "sk-or-v1-abcdef", exp });
  });

  it("rejects a tampered payload with a valid-looking signature shape", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const encoded = __test__openRouterCookieCodec.encode({ key: "real", exp });
    // Flip the first character of the payload portion.
    const [payload, sig] = encoded.split(".");
    const tamperedPayload =
      (payload[0] === "A" ? "B" : "A") + payload.slice(1);
    const tampered = `${tamperedPayload}.${sig}`;
    expect(__test__openRouterCookieCodec.decode(tampered)).toBeNull();
  });

  it("rejects an expired cookie", () => {
    const exp = Math.floor(Date.now() / 1000) - 5;
    const encoded = __test__openRouterCookieCodec.encode({ key: "stale", exp });
    expect(__test__openRouterCookieCodec.decode(encoded)).toBeNull();
  });

  it("rejects a malformed cookie (no dot)", () => {
    expect(__test__openRouterCookieCodec.decode("nothing-here")).toBeNull();
  });

  it("decode under a different SESSION_SECRET fails", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const encoded = __test__openRouterCookieCodec.encode({ key: "x", exp });
    vi.stubEnv("SESSION_SECRET", "different-secret");
    expect(__test__openRouterCookieCodec.decode(encoded)).toBeNull();
  });
});

// iter 19 pen-test: PKCE cookie now carries twitter id so /callback can
// verify the same X session is finishing the flow.
describe("OpenRouter PKCE codec (round-trip with tid binding)", () => {
  it("encodes then decodes back to the original payload, preserving tid", () => {
    const encoded = __test__openRouterPkceCodec.encode({
      verifier: "VERIFIER_ABCDEF",
      state: "STATE_XYZ",
      tid: "123456789",
    });
    const decoded = __test__openRouterPkceCodec.decode(encoded);
    expect(decoded).toEqual({
      verifier: "VERIFIER_ABCDEF",
      state: "STATE_XYZ",
      tid: "123456789",
    });
  });

  it("decode returns null when the cookie is missing fields", () => {
    expect(__test__openRouterPkceCodec.decode("only-one-part")).toBeNull();
    expect(__test__openRouterPkceCodec.decode("state|tid")).toBeNull();
    expect(__test__openRouterPkceCodec.decode("state||verifier")).toBeNull();
    expect(__test__openRouterPkceCodec.decode("|tid|verifier")).toBeNull();
    expect(__test__openRouterPkceCodec.decode("state|tid|")).toBeNull();
  });

  it("decode returns null on empty input", () => {
    expect(__test__openRouterPkceCodec.decode("")).toBeNull();
  });
});
