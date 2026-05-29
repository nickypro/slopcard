import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendAdminSms } from "@/lib/twilio";

// Saved env so tests can mutate process.env without affecting siblings.
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.TWILIO_ACCOUNT_SID = "AC_test_sid";
  process.env.TWILIO_AUTH_TOKEN = "test_token";
  process.env.TWILIO_FROM = "+15551112222";
  process.env.ADMIN_PHONE = "+15553334444";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("sendAdminSms", () => {
  it("returns ok on Twilio 201 and sends Basic auth + form body", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      captured.url = url;
      captured.init = init;
      return new Response("{}", { status: 201 });
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const result = await sendAdminSms("hello world");
    expect(result).toEqual({ ok: true });

    // URL hits the right Twilio endpoint with the configured sid.
    expect(captured.url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC_test_sid/Messages.json"
    );

    // Basic auth header is base64("sid:token").
    const headers = (captured.init?.headers || {}) as Record<string, string>;
    const expectedAuth = Buffer.from("AC_test_sid:test_token").toString(
      "base64"
    );
    expect(headers["Authorization"]).toBe(`Basic ${expectedAuth}`);
    expect(headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );

    // Body is form-encoded with From, To, Body keys.
    const body = String(captured.init?.body ?? "");
    const parsed = new URLSearchParams(body);
    expect(parsed.get("From")).toBe("+15551112222");
    expect(parsed.get("To")).toBe("+15553334444");
    expect(parsed.get("Body")).toBe("hello world");
  });

  it("returns ok:false on Twilio non-2xx without throwing", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("bad", { status: 400 })
    ) as unknown as typeof fetch;
    const result = await sendAdminSms("oops");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("status_400");
  });

  it("returns ok:false when env vars are missing without throwing", async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    // Ensure fetch isn't reached — if it is, this throws and the test fails.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("fetch should not be called when env is unset");
    }) as unknown as typeof fetch;
    const result = await sendAdminSms("should not send");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("missing_env");
  });

  it("returns ok:false when fetch throws without re-throwing", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await sendAdminSms("dropped");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("fetch_error");
  });
});
