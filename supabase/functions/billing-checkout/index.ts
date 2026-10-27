// POST /functions/v1/billing-checkout  { plan, return_url }  (Authorization: owner)
//   → { url }  Stripe Checkout for a subscription to `plan` (docs/07-INTEGRATIONS.md §5).
// The org's Stripe customer is created once (Stripe idempotency key per org) and linked
// through public.billing_link_customer. org.plan changes only when the webhook confirms the
// subscription — never here. An org that already has a plan changes it in the Customer Portal.
import { json, preflight, serviceClient, verifyCaller } from "../_shared/supabase.ts";
import { StripeError, isPlanCode, stripeApi } from "../_shared/stripe-billing.ts";

function returnUrl(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const caller = await verifyCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);
  if (caller.appRole !== "owner") return json({ error: "forbidden" }, 403);

  const body = await req.json().catch(() => null);
  const plan = body?.plan;
  const back = returnUrl(body?.return_url);
  if (!isPlanCode(plan) || !back) return json({ error: "invalid_input" }, 400);

  const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!secretKey) return json({ error: "billing_not_configured" }, 503);

  const admin = serviceClient();
  const { data: org, error } = await admin
    .from("org")
    .select("id, slug, name, plan, stripe_customer_id")
    .eq("id", caller.orgId)
    .single();
  if (error || !org) return json({ error: "org_not_found" }, 404);
  if (org.plan) return json({ error: "already_subscribed" }, 409);

  const stripe = stripeApi(secretKey);
  try {
    let customerId: string | null = org.stripe_customer_id;
    if (!customerId) {
      const { data: user } = await admin.auth.admin.getUserById(caller.userId);
      const created = await stripe.createCustomer({
        id: org.id,
        name: org.name,
        slug: org.slug,
        email: user?.user?.email ?? null,
      });
      const { data: linked, error: linkError } = await admin.rpc("billing_link_customer", {
        p_org_id: org.id,
        p_customer_id: created.id,
      });
      if (linkError || typeof linked !== "string") return json({ error: "link_failed" }, 500);
      customerId = linked;
    }

    const priceId = await stripe.priceIdFor(plan);
    if (!priceId) return json({ error: "price_not_found" }, 400);

    const success = new URL(back);
    success.searchParams.set("checkout", "success");
    const cancel = new URL(back);
    cancel.searchParams.set("checkout", "cancelled");
    const session = await stripe.createCheckoutSession({
      customerId,
      priceId,
      orgId: org.id,
      plan,
      successUrl: success.toString(),
      cancelUrl: cancel.toString(),
    });
    return json({ url: session.url });
  } catch (err) {
    if (err instanceof StripeError) {
      console.error("billing-checkout: stripe error", err.status, err.code);
      return json({ error: "stripe_error" }, 502);
    }
    throw err;
  }
});
