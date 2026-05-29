// Thin OpenRouter client. OpenRouter exposes an OpenAI-compatible REST API so
// we don't need an SDK for one endpoint. JSON mode is requested explicitly;
// we still strip markdown fences defensively because models sometimes return
// ```json blocks despite the response_format hint.
//
// All calls happen server-side; the key never leaves the process.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const DEFAULT_MODEL =
  process.env.SWAPCARD_LLM_MODEL?.trim() || "anthropic/claude-opus-4.8";

export interface LlmCallOptions {
  system: string;
  user: string;
  maxTokens?: number;
  model?: string;
  // If supplied (BYOK path), use this key instead of the server-side env.
  apiKey?: string;
  // Plumbed through to fetch — when the client disconnects mid-stream we
  // want to drop the upstream OpenRouter call too, not finish paying for
  // tokens nobody will read.
  signal?: AbortSignal;
}

export async function callLlmJson<T>(opts: LlmCallOptions): Promise<T> {
  const apiKey = opts.apiKey?.trim() || process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // OpenRouter recommends these for attribution / per-app analytics.
      "HTTP-Referer": process.env.SITE_URL || "https://slopcard.org",
      "X-Title": "slopcard /discover",
    },
    body: JSON.stringify({
      model: opts.model ?? DEFAULT_MODEL,
      max_tokens: opts.maxTokens ?? 8192,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM call failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const rawBody = await res.text();
  let body: {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string; code?: string | number };
  };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    throw new Error(
      `OpenRouter returned non-JSON wrapper (likely upstream provider HTML error): ${rawBody.slice(0, 300)}`
    );
  }
  if (body.error) {
    throw new Error(
      `LLM error: ${body.error.message || JSON.stringify(body.error)}`
    );
  }
  const text = body.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error(
      `LLM returned empty response. Full body keys: ${Object.keys(body).join(",")}`
    );
  }
  return parseJsonLoose<T>(text);
}

// Models occasionally ignore response_format and emit prose around the JSON
// (markdown fences, a sentence prefix, etc.). Strip fences first, then if
// straight parsing fails, fall back to extracting the largest balanced
// {...} block. As a last resort, surface a long snippet to make
// LLM-output bugs diagnosable from logs.
function parseJsonLoose<T>(raw: string): T {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    return JSON.parse(stripped) as T;
  } catch {
    // Find the first '{' and the matching closing '}'.
    const first = stripped.indexOf("{");
    const last = stripped.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(stripped.slice(first, last + 1)) as T;
      } catch {
        /* fall through */
      }
    }
    console.error("[llm] parseJsonLoose failed on (first 1000):", stripped.slice(0, 1000));
    throw new Error(
      `Could not parse LLM JSON. First 300 chars of output: ${stripped.slice(0, 300)}`
    );
  }
}
