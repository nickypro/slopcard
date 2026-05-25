"use client";

import type { Card } from "@/lib/db";

interface Props {
  pending: Card[];
  approved: Card[];
}

function Avatar({ card }: { card: Card }) {
  const src =
    card.avatarUrl || `https://unavatar.io/twitter/${card.handle}`;
  /* eslint-disable-next-line @next/next/no-img-element */
  return <img src={src} alt="" />;
}

function PendingRow({ card }: { card: Card }) {
  return (
    <div className="queue-row">
      <Avatar card={card} />
      <div className="queue-row__main">
        <strong>{card.displayName || `@${card.handle}`}</strong>
        <small>
          @{card.handle} ·{" "}
          <a href={card.swapcardUrl} target="_blank" rel="noreferrer">
            swapcard link ↗
          </a>
        </small>
        {card.description ? (
          <p style={{ margin: "0.3rem 0 0", fontSize: "0.85rem" }}>
            {card.description}
          </p>
        ) : null}
      </div>
      <div className="queue-row__actions">
        <form action="/api/admin/approve" method="post">
          <input type="hidden" name="handle" value={card.handle} />
          <button type="submit">approve</button>
        </form>
        <a className="btn ghost" href={`/admin/edit/${card.handle}`}>
          edit
        </a>
        <form
          action="/api/admin/reject"
          method="post"
          onSubmit={(e) => {
            if (!confirm(`reject @${card.handle}?`)) e.preventDefault();
          }}
        >
          <input type="hidden" name="handle" value={card.handle} />
          <button className="danger" type="submit">
            reject
          </button>
        </form>
      </div>
    </div>
  );
}

function ApprovedRow({ card }: { card: Card }) {
  return (
    <div className="queue-row">
      <Avatar card={card} />
      <div className="queue-row__main">
        <strong>{card.displayName || `@${card.handle}`}</strong>
        <small>
          <a href={`/${card.handle}`} target="_blank" rel="noreferrer">
            /{card.handle} ↗
          </a>{" "}
          ·{" "}
          <a href={`/${card.handle}/card`} target="_blank" rel="noreferrer">
            view card ↗
          </a>
        </small>
      </div>
      <div className="queue-row__actions">
        <a className="btn ghost" href={`/admin/edit/${card.handle}`}>
          edit
        </a>
        <form
          action="/api/admin/delete"
          method="post"
          onSubmit={(e) => {
            if (!confirm(`delete @${card.handle}? this is permanent.`))
              e.preventDefault();
          }}
        >
          <input type="hidden" name="handle" value={card.handle} />
          <button className="danger" type="submit">
            delete
          </button>
        </form>
      </div>
    </div>
  );
}

export default function AdminQueue({ pending, approved }: Props) {
  return (
    <>
      <h2 style={{ marginTop: "1.5rem" }}>pending</h2>
      {pending.length === 0 ? (
        <p className="muted">nothing to review.</p>
      ) : (
        pending.map((c) => <PendingRow key={c.handle} card={c} />)
      )}
      <h2 style={{ marginTop: "2rem" }}>approved</h2>
      {approved.length === 0 ? (
        <p className="muted">no approved cards yet.</p>
      ) : (
        approved.map((c) => <ApprovedRow key={c.handle} card={c} />)
      )}
    </>
  );
}
