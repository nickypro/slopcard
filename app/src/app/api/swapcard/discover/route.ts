import { NextRequest, NextResponse } from "next/server";
import { getCard, getSwapcardAttendeeByAnyId } from "@/lib/db";
import { getOpenRouterKey, getUserSession } from "@/lib/session";
import {
  runDiscover,
  type DiscoverPhaseEvent,
} from "@/lib/swapcard/discover";
import { isFreeHandle } from "@/lib/swapcard/byok";
import { claimDiscoverSlot } from "@/lib/swapcard/rate-limit";
import { classifyDiscoverError, newErrId } from "@/lib/swapcard/error-classifier";
import type { Attendee } from "@/lib/swapcard/types";

export const dynamic = "force-dynamic";

// Streams Server-Sent Events while it works through the pipeline:
//   data: {"phase":"building_query"}\n\n
//   data: {"phase":"vectorising","meta":{...}}\n\n
//   ...
//   data: {"phase":"done","run":{...}}\n\n
// or on failure:
//   data: {"phase":"error","error":"..."}\n\n
//
// Why SSE instead of multiple round-trips? The pipeline has natural
// sub-second phases (vectorise, retrieve, save) sandwiched between long LLM
// calls. Splitting into separate endpoints would force the client to
// orchestrate state across them and we'd lose request locality. A single
// stream lets the server own the sequence.
export async function POST(req: NextRequest) {
  const session = await getUserSession();
  if (!session) {
    return NextResponse.json({ error: "sign in with X first" }, { status: 401 });
  }
  const card = getCard(session.twitterHandle);
  if (!card) {
    return NextResponse.json(
      { error: "no card for this handle — submit one first" },
      { status: 404 }
    );
  }
  if (!card.swapcardPersonId || !card.swapcardEventId) {
    return NextResponse.json(
      { error: "link your Swapcard profile first" },
      { status: 412 }
    );
  }
  const attendeeRow = getSwapcardAttendeeByAnyId(
    card.swapcardEventId,
    card.swapcardPersonId
  );
  if (!attendeeRow) {
    return NextResponse.json(
      { error: "your linked attendee record isn't in the cache — re-ingest" },
      { status: 410 }
    );
  }
  const requester = JSON.parse(attendeeRow.profileJson) as Attendee;

  let body: {
    refresh?: unknown;
    customPrompt?: unknown;
    openrouterKey?: unknown;
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* optional body */
  }

  // BYOK: free handles use the server's key; everyone else must supply one.
  // Precedence: JSON body field > header > signed OpenRouter cookie (set by
  // the PKCE flow at /api/auth/openrouter/start) > server env (only for the
  // free-handle path). The cookie path lets users "Sign in with OpenRouter"
  // once and skip pasting the key on every visit.
  //
  // Free handles get the server env key as a fallback when they HAVEN'T
  // supplied a key — but if they DID supply one (OAuth cookie, pasted in the
  // form, or passed as a header), we honor it. Older logic short-circuited
  // free handles straight to env, which made the OAuth cookie silently
  // ineffective and gave no way to opt out of the env key for owner-style
  // handles.
  const bodyKey =
    typeof body.openrouterKey === "string" ? body.openrouterKey.trim() : "";
  const headerKey = (req.headers.get("x-openrouter-key") ?? "").trim();
  const cookieKey = (await getOpenRouterKey()) ?? "";
  const userKey = bodyKey || headerKey || cookieKey;
  const handleIsFree = isFreeHandle(session.twitterHandle);
  // `undefined` here means "let callLlmJson fall back to OPENROUTER_API_KEY".
  // A non-empty userKey beats that for everyone including free handles.
  const apiKey = userKey || undefined;
  if (!handleIsFree && !userKey) {
    return NextResponse.json(
      {
        error:
          "openrouter key required (running on opus 4.8 costs ~$0.50/run). sign in with OpenRouter or paste a key from openrouter.ai/keys.",
      },
      { status: 402 }
    );
  }

  // Rate-limit before we open the SSE stream. Quota is per-handle / 24h
  // rolling; concurrency is preempted on a new request from the same handle
  // (the older run's AbortSignal fires and its upstream LLM calls drop).
  const decision = claimDiscoverSlot({
    handle: session.twitterHandle,
    isFreeHandle: handleIsFree,
  });
  if (!decision.allow) {
    return NextResponse.json(
      {
        error: `daily quota exceeded — try again in ~${Math.ceil(
          decision.retryAfterSec / 60
        )} min`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(decision.retryAfterSec) },
      }
    );
  }
  const claim = decision.claim;

  const customPrompt =
    typeof body.customPrompt === "string" ? body.customPrompt.slice(0, 4000) : "";

  const goals = card.description?.trim() || requester.needHelp || "";
  const extraContext = [
    requester.biography,
    requester.helpOthers ? `Can offer: ${requester.helpOthers}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          // Browser disconnected mid-stream; mark closed so subsequent
          // phase events don't trip "Controller is already closed".
          closed = true;
        }
      };
      const send = (payload: object) => {
        safeEnqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      const onPhase = (event: DiscoverPhaseEvent) => send(event);

      // SSE comment lines (`:…`) every 15s keep nginx (and other intermediate
      // proxies with a default 60s read timeout) from killing the connection
      // while we wait on long LLM calls.
      const heartbeat = setInterval(() => {
        safeEnqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
      }, 15000);

      // Merge the two abort sources we care about: (a) the client TCP drop,
      // (b) a newer discover request from the same handle preempting this
      // one. Either fires `abortAll.signal`, which we thread into the LLM
      // calls so they drop the upstream OpenRouter fetch.
      const abortAll = new AbortController();
      const onClientAbort = () => {
        closed = true;
        abortAll.abort();
      };
      req.signal.addEventListener("abort", onClientAbort);
      claim.signal.addEventListener("abort", () => {
        send({ phase: "error", error: "preempted by newer request" });
        closed = true;
        abortAll.abort();
      });

      // We only count a run against the daily quota if it actually went
      // through fresh (i.e. didn't short-circuit on the cache). The
      // orchestrator emits `phase: "cached"` when it returns from cache; we
      // flip a flag and pass that to release().
      let cached = false;
      const onPhaseWrapped = (event: DiscoverPhaseEvent) => {
        if (event.phase === "cached") cached = true;
        onPhase(event);
      };

      try {
        const run = await runDiscover({
          handle: card.handle,
          requester,
          requesterPersonId: card.swapcardPersonId!,
          eventId: card.swapcardEventId!,
          extraContext,
          goals,
          customPrompt,
          apiKey,
          refresh: body.refresh === true,
          signal: abortAll.signal,
          onPhase: onPhaseWrapped,
        });
        send({ phase: "done", run });
      } catch (e) {
        // Full stack to the server log only — the client gets a sanitized
        // category. Raw LLM error bodies (and the prompt slice in
        // parseJsonLoose's failure path) shouldn't be surfaced verbatim to
        // arbitrary users; a future upstream change could start including
        // request-ids, partial input echoes, or provider metadata.
        // errId ties stderr to the user-facing message for grep-from-support.
        const errId = newErrId();
        console.error(
          `[swapcard:discover] errId=${errId} handle=@${card.handle}`,
          e
        );
        const raw = e instanceof Error ? e.message : String(e);
        const safe = classifyDiscoverError(raw, errId);
        send({ phase: "error", error: safe });
      } finally {
        clearInterval(heartbeat);
        req.signal.removeEventListener("abort", onClientAbort);
        claim.release({ counted: !cached });
        if (!closed) {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
        closed = true;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Prevents Nginx (in front of the container) from buffering events.
      "X-Accel-Buffering": "no",
    },
  });
}
