import { stripeWebhookRoute } from "@/lib/payments/http";

// docs/05-PAYMENTS.md §5: Stripe webhooks only reconcile `indeterminate` payments; the sale's
// synchronous result is what releases. Configure one endpoint per tenant Stripe account at
// /api/payments/stripe/webhook/<terminal id> (events: payment_intent.succeeded,
// payment_intent.payment_failed, payment_intent.canceled).
export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = stripeWebhookRoute();
