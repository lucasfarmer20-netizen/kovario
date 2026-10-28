import { json, serviceClient } from "../_shared/supabase.ts";
import { customerEmail, deliverCustomerEmail, dispatchAuthorized } from "../_shared/customer-email.ts";

// Invoke from a scheduler using CUSTOMER_EMAIL_DISPATCH_TOKEN; never from the browser.
Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const token = Deno.env.get("CUSTOMER_EMAIL_DISPATCH_TOKEN");
  if (!await dispatchAuthorized(req.headers.get("Authorization"), token)) return json({ error: "unauthorized" }, 401);
  const key = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("RESEND_FROM");
  if (!key || !from) return json({ error: "email_not_configured" }, 503);
  const db = serviceClient();
  const { data: jobs, error } = await db.rpc("customer_email_claim");
  if (error) return json({ error: "claim_failed" }, 503);
  let sent = 0;
  for (const job of jobs ?? []) {
    const [{ data: org }, { data: customer }] = await Promise.all([
      db.from("org").select("name,slug,settings,is_active").eq("id", job.org_id).single(),
      db.from("customer").select("email").eq("id", job.customer_id).eq("org_id", job.org_id).single(),
    ]);
    let failure: string | null = "recipient_unavailable";
    if (org?.is_active && customer?.email) {
      try {
        let payload = job.delivery_payload;
        if (!payload) {
          const message = customerEmail({ kind: job.kind, orgName: org.name, slug: org.slug, reference: job.reference,
            pickupHours: org.settings.pickup_hours ?? "", notice: org.settings.rates_notice || org.settings.receipt_footer || "", tracking: job.tracking });
          payload = { from, to: [customer.email], ...message };
          const { error: snapshotError } = await db.from("customer_email").update({ delivery_payload: payload }).eq("id", job.id);
          if (snapshotError) continue;
        }
        failure = await deliverCustomerEmail(payload, key, job.id);
        if (failure === null) {
          const { error: updateError } = await db.from("customer_email").update({ sent_at: new Date().toISOString(), last_error: null }).eq("id", job.id);
          if (!updateError) sent++;
          continue;
        }
      } catch { failure = "email_transport_failed"; }
    }
    await db.from("customer_email").update({ last_error: failure }).eq("id", job.id);
  }
  return json({ sent });
});
