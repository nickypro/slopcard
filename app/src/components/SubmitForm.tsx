"use client";

import { useState } from "react";

export default function SubmitForm() {
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [swapcardUrl, setSwapcardUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normHandle = handle.replace(/^@/, "").trim();

  async function fetchProfile() {
    if (!normHandle) return;
    setFetching(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/fetch?h=${encodeURIComponent(normHandle)}`
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "fetch failed");
      } else {
        if (data.displayName) setDisplayName(data.displayName);
        if (data.description) setDescription(data.description);
        if (data.avatarUrl) setAvatarUrl(data.avatarUrl);
      }
    } catch {
      setError("network error fetching twitter");
    } finally {
      setFetching(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          handle: normHandle,
          displayName,
          description,
          avatarUrl,
          swapcardUrl,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "submit failed");
      } else {
        window.location.href = `/thanks?token=${encodeURIComponent(
          data.token
        )}&handle=${encodeURIComponent(data.handle)}`;
      }
    } catch {
      setError("network error submitting");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="row">
        <label htmlFor="handle">twitter handle</label>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            id="handle"
            type="text"
            placeholder="cutesuscat"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            autoComplete="off"
          />
          <button
            type="button"
            className="ghost"
            onClick={fetchProfile}
            disabled={!normHandle || fetching}
            style={{ flexShrink: 0 }}
          >
            {fetching ? "fetching…" : "fetch"}
          </button>
        </div>
      </div>

      <div className="row">
        <label htmlFor="displayName">display name</label>
        <input
          id="displayName"
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </div>

      <div className="row">
        <div className="label-row">
          <label htmlFor="description">bio</label>
          <span
            className="label-link"
            style={{
              color:
                description.length >= 280
                  ? "var(--danger)"
                  : description.length >= 250
                  ? "var(--pending)"
                  : "var(--muted)",
              cursor: "default",
            }}
          >
            {description.length} / 280
          </span>
        </div>
        <textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value.slice(0, 280))}
          maxLength={280}
        />
      </div>

      <div className="row">
        <label htmlFor="avatarUrl">avatar url</label>
        <input
          id="avatarUrl"
          type="url"
          value={avatarUrl}
          onChange={(e) => setAvatarUrl(e.target.value)}
          placeholder="https://…"
        />
        {avatarUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={avatarUrl}
            alt=""
            style={{
              width: 48,
              height: 48,
              borderRadius: 999,
              marginTop: "0.5rem",
              objectFit: "cover",
            }}
          />
        ) : null}
      </div>

      <div className="row">
        <div className="label-row">
          <label htmlFor="swapcardUrl">swapcard url *</label>
          <a
            className="label-link"
            href="https://app.swapcard.com/event/eag-london/people/RXZlbnRWaWV3XzEyNzQyMDI="
            target="_blank"
            rel="noreferrer"
          >
            ↗ find your profile on swapcard by searching attendees
          </a>
        </div>
        <input
          id="swapcardUrl"
          type="url"
          required
          value={swapcardUrl}
          onChange={(e) => setSwapcardUrl(e.target.value)}
          placeholder="https://app.swapcard.com/event/.../person/..."
        />
      </div>

      <div className="actions">
        <button
          type="submit"
          disabled={submitting || !normHandle || !swapcardUrl}
        >
          {submitting ? "submitting…" : "submit for review"}
        </button>
      </div>

      {error ? <p className="error">{error}</p> : null}
    </form>
  );
}
