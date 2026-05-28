import { redirect } from "next/navigation";

export default function EditRedirect() {
  // /edit is unified with /submit — the page detects edit-vs-create from the session.
  redirect("/submit");
}
