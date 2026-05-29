import SignInWithX from "@/components/SignInWithX";
import SubmitForm from "@/components/SubmitForm";
import { getCard } from "@/lib/db";
import { getUserSession } from "@/lib/session";
import { siteUrl } from "@/lib/urls";

interface Props {
  searchParams: Promise<{
    signed_in?: string;
    auth_error?: string;
    saved?: string;
  }>;
}

export const dynamic = "force-dynamic";

export default async function SubmitPage({ searchParams }: Props) {
  const { signed_in, auth_error, saved } = await searchParams;
  const session = await getUserSession();
  const existing = session ? getCard(session.twitterHandle) : null;
  const isEdit = !!existing;

  const initialCard = existing
    ? {
        handle: existing.handle,
        displayName: existing.displayName,
        description: existing.description,
        avatarUrl: existing.avatarUrl,
        swapcardUrl: existing.swapcardUrl,
        listed: existing.listed,
      }
    : null;

  return (
    <main className="container">
      <p style={{ marginBottom: "1rem" }}>
        <a href="/" className="muted" style={{ fontSize: "0.9rem" }}>
          ← back to all slopcards
        </a>
      </p>
      <h1 className="title">
        {isEdit ? `edit @${existing!.handle}` : "make a slopcard"}
      </h1>
      <p className="subtitle">
        {isEdit
          ? "changes save immediately. you can also delete your card below — your link + discover access aren't affected."
          : "completely optional — a public profile card shown on the homepage. /discover and /agenda work without it. sign in with X to skip the approval queue, or submit anonymously for manual review."}
      </p>
      {saved ? <p className="ok">✓ saved.</p> : null}
      {signed_in ? (
        <p className="ok" style={{ marginBottom: "1rem" }}>
          {existing
            ? "✓ signed in. you can edit your card below."
            : "✓ signed in. your submission will publish immediately."}
        </p>
      ) : null}
      {auth_error ? (
        <p className="error" style={{ marginBottom: "1rem" }}>
          sign-in failed: <code>{auth_error}</code>
        </p>
      ) : null}

      <SignInWithX />

      <div className="panel">
        <SubmitForm
          initialCard={initialCard}
          verifiedHandle={session?.twitterHandle ?? null}
        />
      </div>

      {isEdit ? (
        <form
          action={siteUrl("/api/delete-self")}
          method="post"
          style={{ marginTop: "2rem" }}
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
            <p
              className="muted"
              style={{ margin: "0 0 1rem", fontSize: "0.9rem" }}
            >
              delete your slopcard. the public page goes away immediately. the
              full snapshot is preserved in the audit log so it can be
              recovered by the admin if you change your mind.
            </p>
            <button type="submit" className="danger">
              delete my slopcard
            </button>
          </div>
        </form>
      ) : null}
    </main>
  );
}
