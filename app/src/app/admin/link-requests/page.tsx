import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { listPendingLinkRequests } from "@/lib/db";

export const dynamic = "force-dynamic";

// Admin queue for pending Swapcard link requests. Server-rendered list with
// inline approve/reject forms that POST to /api/admin/link-requests/decide.
// No client component needed — the redirect on POST refreshes the list.
export default async function AdminLinkRequestsPage() {
  if (!(await isAdmin())) redirect("/admin/login");
  const pending = listPendingLinkRequests();

  return (
    <main className="container">
      <h1 className="title">link requests</h1>
      <p className="subtitle">{pending.length} pending</p>
      {pending.length === 0 ? (
        <p style={{ marginTop: "1rem", color: "var(--muted)" }}>
          no pending requests.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, marginTop: "1rem" }}>
          {pending.map((r) => (
            <li
              key={r.id}
              className="panel"
              style={{ marginBottom: "0.75rem" }}
            >
              <div style={{ marginBottom: "0.5rem" }}>
                <strong>#{r.id}</strong> · @{r.handle} claiming{" "}
                <strong>{r.linkedName || "(unknown)"}</strong>
              </div>
              <div
                style={{
                  fontSize: "0.85rem",
                  color: "var(--muted)",
                  marginBottom: "0.75rem",
                  wordBreak: "break-all",
                }}
              >
                event: {r.eventId} · personId: {r.personId} · requested{" "}
                {new Date(r.requestedAt).toISOString()}
              </div>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <form
                  action="/api/admin/link-requests/decide"
                  method="post"
                  style={{ display: "inline" }}
                >
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="action" value="approve" />
                  <button type="submit">approve</button>
                </form>
                <form
                  action="/api/admin/link-requests/decide"
                  method="post"
                  style={{ display: "inline" }}
                >
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="action" value="reject" />
                  <button type="submit" className="ghost">
                    reject
                  </button>
                </form>
                <a className="btn ghost" href={`/admin/link-requests/${r.approveToken}`}>
                  details
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
      <a className="btn ghost" href="/admin" style={{ marginTop: "1rem" }}>
        back to admin
      </a>
    </main>
  );
}
