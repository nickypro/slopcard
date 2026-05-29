import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { callLlmJson } from "@/lib/swapcard/llm";

// We don't export parseJsonLoose, so we exercise it via callLlmJson and a
// mocked fetch. Each test sets up `globalThis.fetch` to return a fake
// OpenRouter chat-completions body containing the raw text we want to feed
// the parser.

function mockFetchWithContent(content: string) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  );
}

function mockFetchWithBody(bodyText: string, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(bodyText, {
      status,
      headers: { "content-type": "application/json" },
    })
  );
}

describe("callLlmJson + parseJsonLoose (indirect)", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses clean JSON content", async () => {
    mockFetchWithContent('{"hello": "world", "n": 42}');
    const result = await callLlmJson<{ hello: string; n: number }>({
      system: "sys",
      user: "usr",
    });
    expect(result).toEqual({ hello: "world", n: 42 });
  });

  it("strips ```json markdown fences", async () => {
    mockFetchWithContent('```json\n{"k": "v"}\n```');
    const result = await callLlmJson<{ k: string }>({
      system: "sys",
      user: "usr",
    });
    expect(result).toEqual({ k: "v" });
  });

  it("strips plain ``` fences", async () => {
    mockFetchWithContent('```\n{"k": "v"}\n```');
    const result = await callLlmJson<{ k: string }>({
      system: "sys",
      user: "usr",
    });
    expect(result).toEqual({ k: "v" });
  });

  it("extracts {...} block when JSON has prose prefix/suffix", async () => {
    mockFetchWithContent(
      'Sure, here is the result: {"k": "v", "n": 1} Hope that helps!'
    );
    const result = await callLlmJson<{ k: string; n: number }>({
      system: "sys",
      user: "usr",
    });
    expect(result).toEqual({ k: "v", n: 1 });
  });

  it("throws with first chars of output when JSON is unparseable", async () => {
    const badContent = "this is definitely not json {{{ broken";
    mockFetchWithContent(badContent);
    await expect(
      callLlmJson({ system: "s", user: "u" })
    ).rejects.toThrow(/Could not parse LLM JSON.*this is definitely not json/);
  });

  it("throws clearly when content is HTML (no JSON block)", async () => {
    mockFetchWithContent("<html><body>Server error</body></html>");
    await expect(
      callLlmJson({ system: "s", user: "u" })
    ).rejects.toThrow(/Could not parse LLM JSON/);
  });

  it("surfaces OpenRouter `error` field in the wrapper", async () => {
    mockFetchWithBody(
      JSON.stringify({
        error: { message: "rate limited", code: 429 },
      })
    );
    await expect(
      callLlmJson({ system: "s", user: "u" })
    ).rejects.toThrow(/LLM error.*rate limited/);
  });

  it("throws when choices[0].message.content is empty", async () => {
    mockFetchWithContent("");
    await expect(
      callLlmJson({ system: "s", user: "u" })
    ).rejects.toThrow(/LLM returned empty response/);
  });

  it("throws when wrapper is non-JSON (HTML from upstream)", async () => {
    mockFetchWithBody("<html><body>Bad gateway</body></html>", 200);
    await expect(
      callLlmJson({ system: "s", user: "u" })
    ).rejects.toThrow(/non-JSON wrapper/);
  });

  it("throws when OPENROUTER_API_KEY is not set and no apiKey provided", async () => {
    delete process.env.OPENROUTER_API_KEY;
    await expect(
      callLlmJson({ system: "s", user: "u" })
    ).rejects.toThrow(/OPENROUTER_API_KEY not set/);
  });

  it("throws on non-2xx HTTP responses", async () => {
    mockFetchWithBody("upstream broken", 500);
    await expect(
      callLlmJson({ system: "s", user: "u" })
    ).rejects.toThrow(/LLM call failed \(500\).*upstream broken/);
  });
});
