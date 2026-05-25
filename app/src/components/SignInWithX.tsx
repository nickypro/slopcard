"use client";

import { useEffect, useState } from "react";

interface MeResp {
  signedIn: boolean;
  configured: boolean;
  twitterHandle?: string;
  twitterId?: string;
}

export default function SignInWithX() {
  const [me, setMe] = useState<MeResp | null>(null);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then((d) => setMe(d as MeResp))
      .catch(() => setMe({ signedIn: false, configured: false }));
  }, []);

  if (!me) return null;

  if (!me.configured) {
    return (
      <div
        className="muted"
        style={{ fontSize: "0.85rem", marginBottom: "1rem" }}
      >
        X sign-in unavailable on this server. Submissions still work — they
        just need manual approval.
      </div>
    );
  }

  if (me.signedIn) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.6rem",
          marginBottom: "1rem",
        }}
      >
        <span className="tag approved">✓ verified @{me.twitterHandle}</span>
        <form action="/api/auth/logout" method="post" style={{ margin: 0 }}>
          <button className="ghost" type="submit" style={{ fontSize: "0.8rem", padding: "0.35rem 0.7rem" }}>
            sign out
          </button>
        </form>
      </div>
    );
  }

  return (
    <a
      href="/api/auth/twitter/start"
      className="btn"
      style={{
        background: "#000",
        color: "#fff",
        display: "inline-flex",
        alignItems: "center",
        gap: "0.5rem",
        marginBottom: "1rem",
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
      Sign in with X to auto-approve
    </a>
  );
}
