import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendSignalNotification } from "@/lib/signal";

describe("sendSignalNotification", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.SIGNAL_NOTIFICATIONS_ENABLED = "1";
    process.env.SIGNAL_FROM = "+11111111111";
    process.env.SIGNAL_TO = "+12222222222";
    process.env.SIGNAL_DAEMON_URL = "http://172.17.0.1:7583/api/v1/rpc";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // Kill switch is the registration-safety net — until the owner flips
  // SIGNAL_NOTIFICATIONS_ENABLED=1 the function must silently no-op so that
  // pre-registration writes don't accidentally hit a wedged daemon.
  it("no-ops when SIGNAL_NOTIFICATIONS_ENABLED is unset", async () => {
    delete process.env.SIGNAL_NOTIFICATIONS_ENABLED;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await sendSignalNotification("hello");
    expect(r).toEqual({ ok: false, error: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops when SIGNAL_FROM is missing", async () => {
    delete process.env.SIGNAL_FROM;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await sendSignalNotification("hello");
    expect(r).toEqual({ ok: false, error: "missing_env" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops when SIGNAL_TO is missing", async () => {
    delete process.env.SIGNAL_TO;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await sendSignalNotification("hello");
    expect(r).toEqual({ ok: false, error: "missing_env" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a well-formed JSON-RPC payload on the happy path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", result: {}, id: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await sendSignalNotification("test body");
    expect(r).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://172.17.0.1:7583/api/v1/rpc");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      method: "send",
      params: {
        account: "+11111111111",
        recipient: ["+12222222222"],
        message: "test body",
      },
    });
  });

  it("surfaces a non-2xx HTTP status as status_NNN", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 503 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await sendSignalNotification("body");
    expect(r).toEqual({ ok: false, error: "status_503" });
  });

  it("surfaces a JSON-RPC error.code without leaking the message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Untrusted Identity for +1234" },
          id: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await sendSignalNotification("body");
    expect(r).toEqual({ ok: false, error: "rpc_-32603" });
    // The recipient phone number embedded in the rpc error message must not
    // leak through the returned error string.
    expect(r.error).not.toContain("1234");
  });

  it("converts a thrown fetch error into fetch_error and never throws", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    const r = await sendSignalNotification("body");
    expect(r).toEqual({ ok: false, error: "fetch_error" });
  });

  it("honors a custom SIGNAL_DAEMON_URL", async () => {
    process.env.SIGNAL_DAEMON_URL = "http://localhost:9999/rpc";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await sendSignalNotification("body");
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:9999/rpc");
  });

  it("attaches an AbortSignal to the fetch options (timeout plumbing)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await sendSignalNotification("body");
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });
});
