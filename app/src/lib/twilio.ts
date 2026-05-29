// Minimal Twilio SMS sender. Hand-rolled fetch — we don't bring in the
// twilio SDK because the only thing we need is one Messages.json POST with
// HTTP Basic auth. Never throws: link-request creation must succeed even if
// SMS delivery fails (the admin can still see the queue in /admin/link-requests).
// Errors are logged server-side without leaking the auth token or account sid.

const TWILIO_API = "https://api.twilio.com/2010-04-01/Accounts";

export async function sendAdminSms(
  body: string
): Promise<{ ok: boolean; error?: string }> {
  const sid = process.env.TWILIO_ACCOUNT_SID || "";
  const token = process.env.TWILIO_AUTH_TOKEN || "";
  const from = process.env.TWILIO_FROM || "";
  const to = process.env.ADMIN_PHONE || "";
  if (!sid || !token || !from || !to) {
    // Silent no-op when not configured — keeps local dev frictionless and
    // production safe by default. The link route already handles ok:false.
    console.warn("[twilio] missing env vars; skipping SMS send");
    return { ok: false, error: "missing_env" };
  }
  const url = `${TWILIO_API}/${sid}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const form = new URLSearchParams();
  form.set("From", from);
  form.set("To", to);
  form.set("Body", body);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    if (!res.ok) {
      // Surface Twilio's status code without the request body (which can echo
      // the To/From numbers). Auth token + sid never appear in logs.
      console.warn(`[twilio] send failed: status=${res.status}`);
      return { ok: false, error: `status_${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    console.warn(`[twilio] send threw: ${msg}`);
    return { ok: false, error: "fetch_error" };
  }
}
