// Signal-cli JSON-RPC client. Sends a single message via a local signal-cli
// daemon running on the host (NOT inside this container — it's a JVM process
// reached over the docker bridge IP, default 172.17.0.1:7583). Send-only;
// we never read incoming messages.
//
// Never throws: link-request creation must succeed even if Signal delivery
// fails. Errors land in stderr without leaking the daemon URL or recipient
// number to the caller.
//
// Env vars (all required to send; missing any → silent no-op):
//   SIGNAL_DAEMON_URL          — full JSON-RPC URL, default http://172.17.0.1:7583/api/v1/rpc
//   SIGNAL_FROM                — bot's registered Signal number (E.164, e.g. +1XXXXXXXXXX)
//   SIGNAL_TO                  — owner's primary Signal number (E.164)
//   SIGNAL_NOTIFICATIONS_ENABLED  — must be "1" to attempt a send (kill-switch
//                                   so registration mid-flight doesn't spam).

const DEFAULT_DAEMON_URL = "http://172.17.0.1:7583/api/v1/rpc";

export async function sendSignalNotification(
  body: string
): Promise<{ ok: boolean; error?: string }> {
  if (process.env.SIGNAL_NOTIFICATIONS_ENABLED !== "1") {
    return { ok: false, error: "disabled" };
  }
  const from = process.env.SIGNAL_FROM || "";
  const to = process.env.SIGNAL_TO || "";
  if (!from || !to) {
    console.warn("[signal] missing SIGNAL_FROM or SIGNAL_TO; skipping send");
    return { ok: false, error: "missing_env" };
  }
  const url = process.env.SIGNAL_DAEMON_URL || DEFAULT_DAEMON_URL;

  // 2-second timeout. The daemon is on the same host over a unix bridge; if
  // it can't answer in 2s it's wedged. Failing fast keeps the link route's
  // response time tight even if the daemon dies.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "send",
        // Signal-cli's send RPC accepts an array of recipients; we always
        // ship one. Account is the FROM number, recipient is the TO number.
        params: {
          account: from,
          recipient: [to],
          message: body,
        },
        id: 1,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`[signal] send failed: status=${res.status}`);
      return { ok: false, error: `status_${res.status}` };
    }
    // JSON-RPC returns 200 even for errors; check the body's `error` field.
    const data = (await res.json().catch(() => null)) as {
      error?: { code?: number; message?: string };
    } | null;
    if (data?.error) {
      // Strip the message to a code so a future signal-cli change can't leak
      // bot-internal state through stderr.
      const code = data.error.code ?? "unknown";
      console.warn(`[signal] rpc error: code=${code}`);
      return { ok: false, error: `rpc_${code}` };
    }
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    console.warn(`[signal] send threw: ${msg}`);
    return { ok: false, error: "fetch_error" };
  } finally {
    clearTimeout(timer);
  }
}
