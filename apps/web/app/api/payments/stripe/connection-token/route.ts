import { connectionTokenInput, paymentsRoute } from "@/lib/payments/http";
import { stripeConnectionTokenFor } from "@/lib/payments/stripe";

// docs/05-PAYMENTS.md §5: connection tokens for client-side reader discovery are issued by the
// server with the terminal's restricted key (Vault); only the token's secret reaches the browser.
export const runtime = "nodejs";
export const maxDuration = 60;

/** A Stripe Terminal connection token for one of the caller's org's readers. */
export const POST = paymentsRoute(connectionTokenInput, stripeConnectionTokenFor);
