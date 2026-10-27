import { paymentsRoute, reverseInput } from "@/lib/payments/http";
import { reversePayment } from "@/lib/payments/service";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Manager void: a reverse intent for the whole payment; the provider decides void vs refund. */
export const POST = paymentsRoute(reverseInput, (deps, input) =>
  reversePayment(deps, { ...input, kind: "reverse" }),
);
