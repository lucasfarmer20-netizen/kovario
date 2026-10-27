// POST /functions/v1/billing-portal  { return_url }  (Authorization: owner)
//   → { url }  Stripe Customer Portal: change plan, card, invoices, cancel
//   (docs/07-INTEGRATIONS.md §5). Plan changes made there reach org.plan via the webhook.
import { json, preflight, serviceClient, verifyCaller } from "../_shared/supabase.ts";
import { StripeError, stripeApi } from "../_shared/stripe-billing.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const caller = await verifyCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);
  if (caller.appRole !== "owner") return json({ error: "forbidden" }, 403);

  const body = await req.json().catch(() => null);
  let returnUrl: string;
  try {
    const url = new URL(String(body?.return_url ?? ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol");
    returnUrl = url.toString();
  } catch {
    return json({ error: "invalid_input" }, 400);
  }

  const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!secretKey) return json({ error: "billing_not_configured" }, 503);

  const { data: org } = await serviceClient()
    .from("org")
    .select("stripe_customer_id")
    .eq("id", caller.orgId)
    .single();
  if (!org?.stripe_customer_id) return json({ error: "no_customer" }, 409);

  try {
    const portal = await stripeApi(secretKey).createPortalSession({
      customerId: org.stripe_customer_id,
      returnUrl,
    });
    return json({ url: portal.url });
  } catch (err) {
    if (err instanceof StripeError) {
      console.error("billing-portal: stripe error", err.status, err.code);
      return json({ error: "stripe_error" }, 502);
    }
    throw err;
  }
});
