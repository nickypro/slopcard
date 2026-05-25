import { notFound, redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { approveCard, getCard, updateCardFields } from "@/lib/db";

interface Props {
  params: Promise<{ handle: string }>;
}

export const dynamic = "force-dynamic";

export default async function AdminEditPage({ params }: Props) {
  if (!(await isAdmin())) redirect("/admin/login");
  const { handle } = await params;
  const card = getCard(handle);
  if (!card) notFound();

  async function saveAction(formData: FormData) {
    "use server";
    if (!(await isAdmin())) redirect("/admin/login");
    const edits = {
      displayName: String(formData.get("displayName") || ""),
      description: String(formData.get("description") || ""),
      avatarUrl: String(formData.get("avatarUrl") || ""),
      swapcardUrl: String(formData.get("swapcardUrl") || ""),
    };
    const approve = formData.get("approve") === "1";
    if (approve) {
      approveCard(handle, edits);
    } else {
      updateCardFields(handle, edits);
    }
    redirect("/admin");
  }

  return (
    <main className="container">
      <h1 className="title">edit @{card.handle}</h1>
      <p className="subtitle">
        <span className={`tag ${card.status}`}>{card.status}</span>
      </p>
      <form action={saveAction} className="panel">
        <div className="row">
          <label htmlFor="displayName">display name</label>
          <input
            id="displayName"
            name="displayName"
            defaultValue={card.displayName}
          />
        </div>
        <div className="row">
          <label htmlFor="description">bio</label>
          <textarea
            id="description"
            name="description"
            defaultValue={card.description}
          />
        </div>
        <div className="row">
          <label htmlFor="avatarUrl">avatar url</label>
          <input
            id="avatarUrl"
            name="avatarUrl"
            defaultValue={card.avatarUrl}
          />
        </div>
        <div className="row">
          <label htmlFor="swapcardUrl">swapcard url</label>
          <input
            id="swapcardUrl"
            name="swapcardUrl"
            defaultValue={card.swapcardUrl}
          />
        </div>
        <div className="actions">
          {card.status === "pending" ? (
            <button type="submit" name="approve" value="1">
              save + approve
            </button>
          ) : null}
          <button type="submit" className="ghost">
            save
          </button>
          <a className="btn ghost" href="/admin">
            cancel
          </a>
        </div>
      </form>
    </main>
  );
}
