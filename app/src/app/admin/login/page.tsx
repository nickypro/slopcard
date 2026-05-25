import { redirect } from "next/navigation";

interface Props {
  searchParams: Promise<{ token?: string; error?: string }>;
}

export default async function AdminLoginPage({ searchParams }: Props) {
  const { token, error } = await searchParams;

  // ?token=... is a shortcut: hand it to the route handler which CAN set cookies.
  if (token) {
    redirect(`/api/admin/login?token=${encodeURIComponent(token)}`);
  }

  return (
    <main className="container">
      <h1 className="title">admin login</h1>
      <p className="subtitle">paste the ADMIN_TOKEN to enter.</p>
      <form action="/api/admin/login" method="post" className="panel">
        <div className="row">
          <label htmlFor="token">admin token</label>
          <input id="token" name="token" type="text" autoFocus />
        </div>
        <button type="submit">log in</button>
        {error ? <p className="error">invalid token</p> : null}
      </form>
    </main>
  );
}
