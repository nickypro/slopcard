interface Props {
  searchParams: Promise<{ token?: string; handle?: string }>;
}

export default async function ThanksPage({ searchParams }: Props) {
  const { token, handle } = await searchParams;
  return (
    <main className="container">
      <h1 className="title">submitted</h1>
      <p className="subtitle">
        thanks. your card is in the queue for manual review.
      </p>
      <div className="panel">
        <p>
          you submitted <strong>@{handle ?? "your handle"}</strong>.
        </p>
        {token ? (
          <p>
            track its status here:{" "}
            <a href={`/pending/${token}`}>/pending/{token.slice(0, 8)}…</a>
          </p>
        ) : null}
        <p className="muted" style={{ fontSize: "0.9rem" }}>
          once approved, your card will be live at <code>/{handle}</code>.
        </p>
      </div>
      <p style={{ marginTop: "1.5rem" }}>
        <a href="/">← submit another</a>
      </p>
    </main>
  );
}
