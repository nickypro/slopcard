import SignInWithX from "@/components/SignInWithX";
import SubmitForm from "@/components/SubmitForm";

export default function HomePage() {
  return (
    <main className="container">
      <h1 className="title">slopcard</h1>
      <p className="subtitle">
        a little card for your twitter profile that links to your swapcard.
        sign in with X to skip the approval queue.
      </p>
      <SignInWithX />
      <div className="panel">
        <SubmitForm />
      </div>
      <p className="muted" style={{ marginTop: "2rem", fontSize: "0.85rem" }}>
        already have a card? visit slopcard.org/&lt;handle&gt;.
      </p>
    </main>
  );
}
