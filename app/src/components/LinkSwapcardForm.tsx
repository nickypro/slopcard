"use client";

import { useState } from "react";

interface Props {
  initialUrl: string;
  alreadyLinked: boolean;
}

interface LinkOk {
  ok: true;
  pending?: false;
  linkedName: string;
  eventId: string;
  personId: string;
}
// Returned when SWAPCARD_REQUIRE_APPROVAL=1 is set on the server: the link is
// queued for admin review and the user shouldn't be redirected to /discover
// (they don't have access yet). The page will reload to surface the pending
// state from server-rendered link_request row.
interface LinkPending {
  ok: true;
  pending: true;
  requestId: number;
  message: string;
}
interface LinkErr {
  error: string;
}
type LinkResp = LinkOk | LinkPending | LinkErr;

export default function LinkSwapcardForm({ initialUrl, alreadyLinked }: Props) {
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/swapcard/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ swapcardUrl: url.trim() }),
      });
      const data = (await res.json()) as LinkResp;
      if (!res.ok) {
        setError("error" in data ? data.error : "link failed");
        return;
      }
      if ("ok" in data) {
        if (data.pending) {
          // Manual-approval mode: reload so the server-rendered "pending
          // admin approval" panel takes over and the form disappears.
          setSuccess(data.message || "request queued for admin approval");
          setTimeout(() => {
            window.location.reload();
          }, 800);
        } else {
          setSuccess(`linked as ${data.linkedName}`);
          setTimeout(() => {
            window.location.href = "/discover";
          }, 600);
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    if (!confirm("unlink your Swapcard profile from this slopcard?")) return;
    setBusy(true);
    setError(null);
    try {
      await fetch("/api/swapcard/unlink", { method: "POST" });
      window.location.reload();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ marginTop: "1rem" }}>
      <label
        htmlFor="swapcardUrl"
        style={{ display: "block", marginBottom: "0.4rem", fontWeight: 500 }}
      >
        your Swapcard attendee URL
      </label>
      <input
        id="swapcardUrl"
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://app.swapcard.com/event/eag-london-2026/person/..."
        required
        style={{
          width: "100%",
          padding: "0.6rem",
          fontSize: "0.9rem",
          fontFamily: "monospace",
        }}
      />
      <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}>
        open Swapcard, navigate to your own profile, copy the address bar URL.
        works with both EventPeople and CommunityProfile URL schemes.
      </p>

      {error ? <p className="error">{error}</p> : null}
      {success ? <p className="ok">{success} → opening /discover…</p> : null}

      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          marginTop: "1rem",
          alignItems: "center",
        }}
      >
        <button
          type="submit"
          className="btn primary"
          disabled={busy || !url.trim()}
        >
          {busy ? "verifying…" : alreadyLinked ? "re-verify" : "verify & link"}
        </button>
        {alreadyLinked ? (
          <button
            type="button"
            onClick={unlink}
            disabled={busy}
            className="btn ghost"
          >
            unlink
          </button>
        ) : null}
      </div>
    </form>
  );
}
