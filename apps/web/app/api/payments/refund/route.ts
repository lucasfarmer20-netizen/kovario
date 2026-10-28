import { paymentsRoute, refundInput } from "@/lib/payments/http";
import { reversePayment } from "@/lib/payments/service";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Manager refund of an amount (≤ the captured amount). Refunds never release (S11). */
export const POST = paymentsRoute(refundInput, (deps, input) =>
  reversePayment(deps, { ...input, kind: "refund" }),
);
