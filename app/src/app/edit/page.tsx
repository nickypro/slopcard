import { redirect } from "next/navigation";
import { getCard } from "@/lib/db";
import { getUserSession } from "@/lib/session";
import { siteUrl } from "@/lib/urls";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ saved?: string; error?: string }>;
}

export default async function EditPage({ searchParams }: Props) {
  const { saved, error } = await searchParams;
  const session = await getUserSession();
  if (!session) redirect("/submit");
  const card = getCard(session.twitterHandle);
  if (!card) {
    return (
      <main className="container">
        <p style={{ marginBottom: "1rem" }}>
          <a href="/" className="muted" style={{ fontSize: "0.9rem" }}>
            ← back to all slopcards
          </a>
        </p>
        <h1 className="title">edit my slopcard</h1>
        <p className="subtitle">
          you don&apos;t have a slopcard yet, @{session.twitterHandle}.{" "}
          <a href="/submit">make one</a>.
        </p>
      </main>
    );
  }

  return (
    <main className="container">
      <p style={{ marginBottom: "1rem" }}>
        <a href="/" className="muted" style={{ fontSize: "0.9rem" }}>
          ← back to all slopcards
        </a>
      </p>
      <h1 className="title">edit @{card.handle}</h1>
      <p className="subtitle">
        you&apos;re signed in as <strong>@{card.handle}</strong>. changes save
        immediately and are recorded in the audit log.
      </p>
      {saved ? <p className="ok">✓ saved.</p> : null}
      {error ? <p className="error">{error}</p> : null}

      <form action={siteUrl("/api/edit")} method="post" className="panel">
        <div className="row">
          <label htmlFor="displayName">display name</label>
          <input
            id="displayName"
            name="displayName"
            type="text"
            defaultValue={card.displayName}
          />
        </div>

        <div className="row">
          <label htmlFor="description">bio</label>
          <textarea
            id="description"
            name="description"
            defaultValue={card.description}
            maxLength={280}
          />
          <p
            className="muted"
            style={{ fontSize: "0.78rem", margin: "0.25rem 0 0" }}
          >
            max 280 characters.
          </p>
        </div>

        <div className="row">
          <label htmlFor="avatarUrl">avatar url</label>
          <input
            id="avatarUrl"
            name="avatarUrl"
            type="url"
            defaultValue={card.avatarUrl}
          />
        </div>

        <div className="row">
          <label htmlFor="swapcardUrl">swapcard url</label>
          <input
            id="swapcardUrl"
            name="swapcardUrl"
            type="url"
            defaultValue={card.swapcardUrl}
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
              cursor: "pointer",
              fontWeight: 500,
              color: "var(--ink)",
            }}
          >
            <input
              id="listed"
              type="checkbox"
              name="listed"
              defaultChecked={card.listed}
              style={{ width: 16, height: 16, cursor: "pointer" }}
            />
            show on the public grid at slopcard.org
          </label>
        </div>

        <div className="actions">
          <button type="submit">save changes</button>
          <a className="btn ghost" href={`/${card.handle}`}>
            cancel
          </a>
        </div>
      </form>

      <form
        action={siteUrl("/api/delete-self")}
        method="post"
        style={{ marginTop: "2rem" }}
        onSubmit={undefined}
      >
        <div
          className="panel"
          style={{
            border: "1px solid var(--danger)",
            background: "rgba(192, 57, 43, 0.04)",
          }}
        >
          <h3 style={{ margin: "0 0 0.5rem", color: "var(--danger)" }}>
            danger zone
          </h3>
          <p className="muted" style={{ margin: "0 0 1rem", fontSize: "0.9rem" }}>
            delete your slopcard. the public page goes away immediately. the
            full snapshot is preserved in the audit log so it can be recovered
            by the admin if you change your mind.
          </p>
          <button
            type="submit"
            className="danger"
            formAction={siteUrl("/api/delete-self")}
          >
            delete my slopcard
          </button>
        </div>
      </form>
    </main>
  );
}
