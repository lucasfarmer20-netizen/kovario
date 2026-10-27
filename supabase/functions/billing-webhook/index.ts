// POST /functions/v1/billing-webhook  (Stripe → Filletry; no JWT, Stripe-Signature instead)
// Verifies the signature over the raw body, then applies customer.subscription.* events to
// org.plan through public.billing_apply_subscription (dedupe by event id, out-of-order
// safe). Every other event type is acknowledged and ignored. Configure the Stripe endpoint
// with: customer.subscription.created, customer.subscription.updated,
// customer.subscription.deleted.
import { json, serviceClient } from "../_shared/supabase.ts";
import { subscriptionChange, verifyStripeSignature } from "../_shared/stripe-billing.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) return json({ error: "billing_not_configured" }, 503);

  const payload = await req.text();
  if (!(await verifyStripeSignature(payload, req.headers.get("Stripe-Signature"), secret))) {
    return json({ error: "invalid_signature" }, 400);
  }

  let event: { type?: unknown } | null = null;
  try {
    event = JSON.parse(payload);
  } catch {
    return json({ error: "invalid_payload" }, 400);
  }
  const change = subscriptionChange(event);
  if (!change) return json({ received: true, ignored: true });

  const { data, error } = await serviceClient().rpc("billing_apply_subscription", {
    p_event_id: change.eventId,
    p_event_created: change.eventCreated,
    p_kind: String(event?.type),
    p_customer_id: change.customerId,
    p_subscription_id: change.subscriptionId,
    p_status: change.status,
    p_plan: change.plan,
    p_org_hint: change.orgIdHint,
  });
  if (error) {
    // 500 → Stripe retries the delivery; the event id makes the retry safe.
    console.error("billing-webhook: apply failed", error.code);
    return json({ error: "apply_failed" }, 500);
  }
  return json({ received: true, result: data });
});
