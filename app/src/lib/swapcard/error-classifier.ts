import { randomBytes } from "crypto";

// Maps raw orchestrator/LLM-client errors to a sanitized message we're willing
// to surface to an end user. The raw text from `callLlmJson` can include LLM
// output snippets (parseJsonLoose's failure path keeps first 300 chars) and
// OpenRouter wrapper bodies. Neither is sensitive today, but both are
// future-proofing risks — a provider change could start emitting trace IDs,
// model-internal reasoning, or partial echoes of the requester's bio. The
// full string still lands in stderr via the route's console.error.
//
// `errId` is appended verbatim when supplied so the user can paste a short
// token back and we can grep stderr for `errId=…`. Same behavior for free
// (env-key) and BYOK paths, so support requests are consistent.

export function newErrId(): string {
  // 24 bits → 6 hex chars. Plenty unique at conference scale; collisions are
  // a non-issue because the corresponding raw stderr line is also tagged.
  return randomBytes(3).toString("hex");
}

export function classifyDiscoverError(raw: string, errId?: string): string {
  const s = (raw ?? "").toLowerCase();
  const tail = errId ? ` [err:${errId}]` : "";

  if (s.includes("openrouter_api_key not set") || s.includes("missing api key")) {
    return "OpenRouter key not configured. paste one in the form or sign in with OpenRouter." + tail;
  }
  if (s.startsWith("llm call failed (401") || s.includes(" 401 ")) {
    return "OpenRouter rejected the key (401). check it's still valid." + tail;
  }
  if (s.startsWith("llm call failed (402") || s.includes("insufficient credit")) {
    return "OpenRouter says insufficient credit. top up or switch model." + tail;
  }
  if (s.startsWith("llm call failed (429") || s.includes("rate limit")) {
    return "OpenRouter rate limit hit — wait a minute and retry." + tail;
  }
  if (s.startsWith("llm call failed (5") || s.includes("upstream")) {
    return "upstream LLM provider error. retry; if it persists, switch model." + tail;
  }
  // Network-layer fetch failures from undici / Node. These look very different
  // from upstream HTTP errors and warrant their own bucket so the user knows
  // it's a connectivity issue (DNS, refused, mid-flight reset, TLS handshake)
  // rather than something about their key. Generic "fetch failed" message
  // surfaces with no upstream status code attached.
  if (
    s.includes("fetch failed") ||
    s.includes("enotfound") ||
    s.includes("econnrefused") ||
    s.includes("etimedout") ||
    s.includes("econnreset") ||
    s.includes("socket hang up") ||
    s.includes("getaddrinfo") ||
    s.includes("network socket disconnected") ||
    (s.includes("typeerror") && s.includes("fetch"))
  ) {
    return "couldn't reach OpenRouter (network error). retry; if it persists, check status.openrouter.ai." + tail;
  }
  if (s.includes("could not parse llm json")) {
    return "the LLM returned malformed JSON. retry, or switch to a model with stricter JSON adherence." + tail;
  }
  if (s.includes("openrouter returned non-json")) {
    return "OpenRouter returned an unexpected response shape. retry; check OpenRouter status." + tail;
  }
  if (s.includes("no attendee data ingested") || s.includes("attendee cache is empty")) {
    return "attendee dataset isn't loaded on this server yet. an admin needs to run the ingest first." + tail;
  }
  if (s.includes("aborted") || s.includes("the operation was aborted")) {
    return "request aborted (either you reloaded, or a newer run preempted this one)." + tail;
  }
  return "discover failed — check server logs." + tail;
}
