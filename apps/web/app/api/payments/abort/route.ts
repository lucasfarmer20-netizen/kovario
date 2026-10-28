import { paymentInput, paymentsRoute } from "@/lib/payments/http";
import { abortPayment } from "@/lib/payments/service";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Cashier Cancel: provider.abort; returns at once (the sale's own request records the outcome). */
export const POST = paymentsRoute(paymentInput, abortPayment);
