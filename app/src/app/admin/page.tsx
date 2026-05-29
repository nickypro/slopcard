import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { countPendingLinkRequests, listCardsByStatus } from "@/lib/db";
import AdminQueue from "@/components/AdminQueue";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  if (!(await isAdmin())) redirect("/admin/login");

  const pending = listCardsByStatus("pending");
  const approved = listCardsByStatus("approved");
  const pendingLinkRequests = countPendingLinkRequests();

  return (
    <main className="container">
      <h1 className="title">admin</h1>
      <p className="subtitle">
        cards: {pending.length} pending · {approved.length} approved
      </p>
      {/* Link-request queue is the active surface in manual-approval mode.
          Prominent CTA so the admin doesn't have to remember the URL. */}
      <div
        className="panel"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
          marginBottom: "1rem",
        }}
      >
        <div>
          <strong>Swapcard link requests:</strong>{" "}
          {pendingLinkRequests === 0
            ? "no pending requests"
            : `${pendingLinkRequests} pending`}
        </div>
        <a
          className={`btn ${pendingLinkRequests > 0 ? "primary" : "ghost"}`}
          href="/admin/link-requests"
        >
          open queue →
        </a>
      </div>
      <AdminQueue pending={pending} approved={approved} />
      <form action="/api/admin/logout" method="post" style={{ marginTop: "2rem" }}>
        <button className="ghost" type="submit">
          log out
        </button>
      </form>
    </main>
  );
}
