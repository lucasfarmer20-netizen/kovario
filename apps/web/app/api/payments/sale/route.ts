import { paymentsRoute, saleInput } from "@/lib/payments/http";
import { chargePayment } from "@/lib/payments/service";

// docs/05-PAYMENTS.md §1: the sale blocks up to ~150 s on the terminal — Node runtime, never
// Edge; 300 s is the Vercel Hobby Fluid Compute maximum (DECISION-18).
export const runtime = "nodejs";
export const maxDuration = 300;

/** Charge: pending payment → provider.sale → result (+ status check when indeterminate). */
export const POST = paymentsRoute(saleInput, chargePayment);
