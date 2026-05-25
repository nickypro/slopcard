import SignInWithX from "@/components/SignInWithX";
import SubmitForm from "@/components/SubmitForm";

interface Props {
  searchParams: Promise<{ signed_in?: string; auth_error?: string }>;
}

export default async function SubmitPage({ searchParams }: Props) {
  const { signed_in, auth_error } = await searchParams;
  return (
    <main className="container">
      <p style={{ marginBottom: "1rem" }}>
        <a href="/" className="muted" style={{ fontSize: "0.9rem" }}>
          ← back to all slopcards
        </a>
      </p>
      <h1 className="title">make a slopcard</h1>
      <p className="subtitle">
        sign in with X to skip the approval queue, or submit anonymously for
        manual review.
      </p>
      {signed_in ? (
        <p className="ok" style={{ marginBottom: "1rem" }}>
          ✓ signed in. your submission will publish immediately.
        </p>
      ) : null}
      {auth_error ? (
        <p className="error" style={{ marginBottom: "1rem" }}>
          sign-in failed: <code>{auth_error}</code>
        </p>
      ) : null}
      <SignInWithX />
      <div className="panel">
        <SubmitForm />
      </div>
    </main>
  );
}
