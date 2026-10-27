import { paymentInput, paymentsRoute } from "@/lib/payments/http";
import { checkPaymentStatus } from "@/lib/payments/service";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Status check for a pending / indeterminate payment (docs/05 §2.4). */
export const POST = paymentsRoute(paymentInput, checkPaymentStatus);
