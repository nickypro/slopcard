import { notFound, redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { getLinkRequestByToken } from "@/lib/db";

interface Props {
  params: Promise<{ token: string }>;
}

export const dynamic = "force-dynamic";

// Per-request detail page reached via the SMS-delivered token link. Same
// admin gate as the queue index; uses the approve_token instead of the
// numeric id so the URL in the SMS isn't trivially enumerable.
export default async function AdminLinkRequestDetailPage({ params }: Props) {
  if (!(await isAdmin())) redirect("/admin/login");
  const { token } = await params;
  const req = getLinkRequestByToken(token);
  if (!req) notFound();

  const decided = req.state !== "pending";

  return (
    <main className="container">
      <h1 className="title">link request #{req.id}</h1>
      <p className="subtitle">
        <span className={`tag ${req.state}`}>{req.state}</span>
      </p>
      <div className="panel" style={{ marginTop: "1rem" }}>
        <p>
          <strong>handle:</strong> @{req.handle}
        </p>
        <p>
          <strong>linked name:</strong> {req.linkedName || "(unknown)"}
        </p>
        <p style={{ wordBreak: "break-all" }}>
          <strong>person id:</strong> {req.personId}
        </p>
        <p>
          <strong>event:</strong> {req.eventId}
        </p>
        <p>
          <strong>requested:</strong>{" "}
          {new Date(req.requestedAt).toISOString()}
        </p>
        {req.decidedAt ? (
          <p>
            <strong>decided:</strong>{" "}
            {new Date(req.decidedAt).toISOString()} by{" "}
            {req.decidedBy || "?"}
          </p>
        ) : null}
        {!decided ? (
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
            <form
              action="/api/admin/link-requests/decide"
              method="post"
              style={{ display: "inline" }}
            >
              <input type="hidden" name="id" value={req.id} />
              <input type="hidden" name="action" value="approve" />
              <button type="submit">approve</button>
            </form>
            <form
              action="/api/admin/link-requests/decide"
              method="post"
              style={{ display: "inline" }}
            >
              <input type="hidden" name="id" value={req.id} />
              <input type="hidden" name="action" value="reject" />
              <button type="submit" className="ghost">
                reject
              </button>
            </form>
          </div>
        ) : null}
      </div>
      <a
        className="btn ghost"
        href="/admin/link-requests"
        style={{ marginTop: "1rem" }}
      >
        back to queue
      </a>
    </main>
  );
}
