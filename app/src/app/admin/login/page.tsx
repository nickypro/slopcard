import { redirect } from "next/navigation";
import { setAdminCookie, verifyToken } from "@/lib/auth";

interface Props {
  searchParams: Promise<{ token?: string; error?: string }>;
}

export default async function AdminLoginPage({ searchParams }: Props) {
  const { token, error } = await searchParams;

  if (token && verifyToken(token)) {
    await setAdminCookie(token);
    redirect("/admin");
  }

  async function loginAction(formData: FormData) {
    "use server";
    const t = String(formData.get("token") || "");
    if (verifyToken(t)) {
      await setAdminCookie(t);
      redirect("/admin");
    }
    redirect("/admin/login?error=1");
  }

  return (
    <main className="container">
      <h1 className="title">admin login</h1>
      <p className="subtitle">paste the ADMIN_TOKEN to enter.</p>
      <form action={loginAction} className="panel">
        <div className="row">
          <label htmlFor="token">admin token</label>
          <input id="token" name="token" type="text" autoFocus />
        </div>
        <button type="submit">log in</button>
        {error ? <p className="error">invalid token</p> : null}
        {token && !verifyToken(token) ? (
          <p className="error">token from URL did not match</p>
        ) : null}
      </form>
    </main>
  );
}
