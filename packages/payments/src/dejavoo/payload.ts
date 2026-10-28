// SPIn REST v2 request bodies (docs/05-PAYMENTS.md §4). Auth travels in the JSON body
// (`Authkey`, `Tpn`), not in headers; `RegisterId` is omitted unless the terminal config sets
// one; `Amount` is numeric; the terminal's own receipt is suppressed (DECISION-13).
import type { SpinTerminal } from "./config.ts";

export const SPIN_OPS = ["Sale", "Void", "Return", "Status", "AbortTransaction"] as const;
export type SpinOp = (typeof SPIN_OPS)[number];

export interface SpinFields {
  referenceId: string;
  /** dollars; Sale / Void / Return */
  amount?: number;
  originalReferenceId?: string;
  originalTransNum?: string;
  proxyTimeoutSecs: number;
}

/** Dollars as a JSON number in cents precision (25, 25.5 — never "25.00"); throws if not a positive cent amount. */
export function spinAmount(amount: number): number {
  const cents = Math.round(amount * 100);
  if (!Number.isFinite(amount) || cents <= 0 || Math.abs(amount * 100 - cents) > 1e-6) {
    throw new RangeError(`Amount must be a positive amount in cents, got ${amount}`);
  }
  return cents / 100;
}

export function spinUrl(t: SpinTerminal, op: SpinOp): string {
  return `${t.baseUrl}/v2/Payment/${op}`;
}

export function buildSpinBody(t: SpinTerminal, fields: SpinFields): Record<string, unknown> {
  const body: Record<string, unknown> = {
    PaymentType: "Credit",
    ReferenceId: fields.referenceId,
    PrintReceipt: "No",
    GetReceipt: "No",
    CaptureSignature: false,
    GetExtendedData: true,
    SPInProxyTimeout: fields.proxyTimeoutSecs,
    Tpn: t.tpn,
    Authkey: t.authkey,
  };
  if (t.registerId) body.RegisterId = t.registerId;
  if (fields.amount !== undefined) body.Amount = spinAmount(fields.amount);
  if (fields.originalReferenceId) body.OriginalReferenceId = fields.originalReferenceId;
  if (fields.originalTransNum) body.OriginalTransNum = fields.originalTransNum;
  return body;
}
