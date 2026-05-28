"use client";

import { useEffect, useRef, useState } from "react";

interface MeResp {
  signedIn: boolean;
  twitterHandle?: string;
}

interface InitialCard {
  handle: string;
  displayName: string;
  description: string;
  avatarUrl: string;
  swapcardUrl: string;
  listed: boolean;
}

interface Props {
  /** If provided, the form is in edit mode — fields prefilled, POSTs to /api/edit. */
  initialCard?: InitialCard | null;
  /** The verified-X handle, if any. Comes from the server-side session. */
  verifiedHandle?: string | null;
}

const DRAFT_KEY = "slopcard:draft:v1";

interface Draft {
  handle?: string;
  displayName?: string;
  description?: string;
  avatarUrl?: string;
  swapcardUrl?: string;
  listed?: boolean;
}

function loadDraft(): Draft {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return {};
    const d = JSON.parse(raw) as Draft;
    return d && typeof d === "object" ? d : {};
  } catch {
    return {};
  }
}
function saveDraft(d: Draft) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    /* quota / disabled — ignore */
  }
}
function clearDraft() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

export default function SubmitForm({
  initialCard = null,
  verifiedHandle = null,
}: Props) {
  const isEdit = !!initialCard;
  const [me, setMe] = useState<MeResp | null>(
    verifiedHandle
      ? { signedIn: true, twitterHandle: verifiedHandle }
      : null
  );
  const [handle, setHandle] = useState(
    initialCard?.handle || verifiedHandle || ""
  );
  const [displayName, setDisplayName] = useState(initialCard?.displayName || "");
  const [description, setDescription] = useState(
    initialCard?.description || ""
  );
  const [avatarUrl, setAvatarUrl] = useState(initialCard?.avatarUrl || "");
  const [swapcardUrl, setSwapcardUrl] = useState(initialCard?.swapcardUrl || "");
  const [listed, setListed] = useState(
    initialCard ? initialCard.listed : true
  );
  const [fetching, setFetching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifiedAutoFetched, setVerifiedAutoFetched] = useState(false);
  const draftHydrated = useRef(false);

  // Hydrate from localStorage on first mount — only in create mode.
  useEffect(() => {
    if (isEdit) {
      draftHydrated.current = true;
      return;
    }
    const d = loadDraft();
    if (d.handle && !verifiedHandle) setHandle(d.handle);
    if (d.displayName) setDisplayName(d.displayName);
    if (d.description) setDescription(d.description);
    if (d.avatarUrl) setAvatarUrl(d.avatarUrl);
    if (d.swapcardUrl) setSwapcardUrl(d.swapcardUrl);
    if (typeof d.listed === "boolean") setListed(d.listed);
    draftHydrated.current = true;
  }, [isEdit, verifiedHandle]);

  // If we didn't already get the session from server props, fetch it.
  useEffect(() => {
    if (me) return;
    fetch("/api/me")
      .then((r) => r.json())
      .then((data: MeResp) => {
        setMe(data);
        if (!isEdit && data.signedIn && data.twitterHandle && !handle) {
          setHandle(data.twitterHandle);
        }
      })
      .catch(() => setMe({ signedIn: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-fetch twitter profile for verified users in CREATE mode.
  useEffect(() => {
    if (isEdit) return;
    if (
      me?.signedIn &&
      me.twitterHandle &&
      !verifiedAutoFetched &&
      !displayName &&
      !description &&
      !avatarUrl
    ) {
      setVerifiedAutoFetched(true);
      doFetch(me.twitterHandle);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, verifiedAutoFetched, isEdit]);

  // Persist draft (create mode only).
  useEffect(() => {
    if (isEdit || !draftHydrated.current) return;
    saveDraft({
      handle: me?.signedIn ? undefined : handle,
      displayName,
      description,
      avatarUrl,
      swapcardUrl,
      listed,
    });
  }, [handle, displayName, description, avatarUrl, swapcardUrl, listed, me, isEdit]);

  const lockedHandle = isEdit
    ? initialCard!.handle
    : me?.signedIn
    ? me.twitterHandle
    : null;
  const normHandle = (lockedHandle || handle.replace(/^@/, "")).trim();

  async function doFetch(h: string) {
    if (!h) return;
    setFetching(true);
    setError(null);
    try {
      const res = await fetch(`/api/fetch?h=${encodeURIComponent(h)}`);
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
      if (isEdit) {
        const form = new FormData();
        form.set("displayName", displayName);
        form.set("description", description);
        form.set("avatarUrl", avatarUrl);
        form.set("swapcardUrl", swapcardUrl);
        if (listed) form.set("listed", "on");
        const res = await fetch("/api/edit", {
          method: "POST",
          body: form,
          redirect: "manual",
        });
        if (res.status === 0 || res.status >= 300) {
          // server redirects on success too; in either case, refresh the page
          window.location.href = "/submit?saved=1";
        } else {
          window.location.reload();
        }
      } else {
        const res = await fetch("/api/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            handle: normHandle,
            displayName,
            description,
            avatarUrl,
            swapcardUrl,
            listed,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "submit failed");
        } else {
          clearDraft();
          if (data.autoApproved) {
            window.location.href = `/${encodeURIComponent(data.handle)}`;
          } else {
            window.location.href = `/thanks?token=${encodeURIComponent(
              data.token
            )}&handle=${encodeURIComponent(data.handle)}`;
          }
        }
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
        {lockedHandle ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              background: "var(--paper-2)",
              border: "1px solid var(--line-strong)",
              borderRadius: 8,
              padding: "0.65rem 0.85rem",
            }}
          >
            <strong>@{lockedHandle}</strong>
            <span className="tag approved" style={{ marginLeft: "auto" }}>
              {isEdit ? "✓ editing your card" : "✓ verified — auto-approve"}
            </span>
          </div>
        ) : (
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
              onClick={() => doFetch(handle.replace(/^@/, "").trim())}
              disabled={!handle.replace(/^@/, "").trim() || fetching}
              style={{ flexShrink: 0 }}
            >
              {fetching ? "fetching…" : "fetch"}
            </button>
          </div>
        )}
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
        <p className="muted" style={{ fontSize: "0.78rem", margin: "0.25rem 0 0" }}>
          line breaks are preserved (italic on the card).
        </p>
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

      <div className="row">
        <label
          htmlFor="listed"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            textTransform: "none",
            letterSpacing: 0,
            fontSize: "0.92rem",
            color: "var(--ink)",
            cursor: "pointer",
            fontWeight: 500,
          }}
        >
          <input
            id="listed"
            type="checkbox"
            checked={listed}
            onChange={(e) => setListed(e.target.checked)}
            style={{ width: 16, height: 16, cursor: "pointer" }}
          />
          show on the public grid at slopcard.org
        </label>
        <p
          className="muted"
          style={{ fontSize: "0.78rem", margin: "0.25rem 0 0 1.6rem" }}
        >
          uncheck to keep unlisted — the card still works at slopcard.org/{normHandle || "<handle>"}, it just won&apos;t appear on the front page.
        </p>
      </div>

      <div className="actions">
        <button
          type="submit"
          disabled={submitting || !normHandle || !swapcardUrl}
        >
          {submitting
            ? "saving…"
            : isEdit
            ? "save changes"
            : lockedHandle
            ? "publish my slopcard"
            : "submit for review"}
        </button>
      </div>

      {error ? <p className="error">{error}</p> : null}
    </form>
  );
}
