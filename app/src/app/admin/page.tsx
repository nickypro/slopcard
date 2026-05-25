import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { listCardsByStatus } from "@/lib/db";
import AdminQueue from "@/components/AdminQueue";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  if (!(await isAdmin())) redirect("/admin/login");

  const pending = listCardsByStatus("pending");
  const approved = listCardsByStatus("approved");

  return (
    <main className="container">
      <h1 className="title">admin</h1>
      <p className="subtitle">
        {pending.length} pending · {approved.length} approved
      </p>
      <AdminQueue pending={pending} approved={approved} />
      <form action="/api/admin/logout" method="post" style={{ marginTop: "2rem" }}>
        <button className="ghost" type="submit">
          log out
        </button>
      </form>
    </main>
  );
}
