// Register screen state (docs/06-STATIONS-UX.md Register, docs/05-PAYMENTS.md §2). The cart,
// its totals and every payment come from the server (register_order_json); this module only
// decides what the cashier sees and may do next. No money is computed here — tax and totals are
// the server's (packages/rules tax.ts → app.tax_amount).

export type TenderType = "card" | "cash" | "check" | "external" | "comp";
export type PaymentState =
  | "pending"
  | "approved"
  | "declined"
  | "cancelled"
  | "indeterminate"
  | "voided"
  | "refunded"
  | "error";

export type CartLine = {
  id: string;
  kind: "settlement" | "storage" | "charge" | "retail";
  description: string;
  qty: number;
  unit_price: number;
  amount: number;
  charge_id: string | null;
  settlement_id: string | null;
  batch_id: string | null;
  retail_product_id: string | null;
};

export type CartPayment = {
  id: string;
  number: string;
  state: PaymentState;
  provider: string;
  amount: number;
  requested_amount: number | null;
  tender: TenderType;
  tender_ref: string | null;
  attempt: number;
  card_brand: string | null;
  card_last4: string | null;
  entry_mode: string | null;
  auth_code: string | null;
  decline_reason: string | null;
  message: string | null;
  reversed_amount: number | null;
};

export type Cart = {
  id: string;
  number: string;
  kind: "sale" | "refund";
  state: "open" | "paid" | "void";
  customer: { id: string; name: string; phone: string | null } | null;
  lines: CartLine[];
  totals: { subtotal: number; tax: number; total: number; paid: number; due: number };
  payments: CartPayment[];
  blocking_payment_id: string | null;
  tax_setting: { mode: string; rate: number; cap_amount: number | null };
  notices?: Notice[];
};

export type Notice = {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
  batch_id?: string;
};

/** What /api/payments/* answers: the payment after the call and its cart. */
export type PaymentResult = {
  status: string;
  payment: CartPayment;
  order: Cart | null;
};

export const LINE_KIND_LABELS: Record<CartLine["kind"], string> = {
  settlement: "Settlement",
  storage: "Storage pickup",
  charge: "Charge",
  retail: "Retail",
};

export const TENDER_LABELS: Record<TenderType, string> = {
  card: "Card (terminal)",
  cash: "Cash",
  check: "Check",
  external: "External terminal",
  comp: "COMP (manager)",
};

export function money(n: number | null | undefined): string {
  return `$${(n ?? 0).toFixed(2)}`;
}

/**
 * The Charge panel's phase:
 *   idle          — ready to charge;
 *   present_card  — the sale is on the terminal ("Present card", Cancel available);
 *   cancelling    — Cancel sent; the UI is unblocked, the outcome is being reconciled;
 *   approved      — this payment is approved and the cart is paid (receipt);
 *   partial       — approved for less than asked: collect the rest on a second line;
 *   declined      — the bank's reason; retry allowed (new ref);
 *   cancelled     — quiet; retry allowed;
 *   indeterminate — the terminal did not confirm: never charge again until resolved;
 *   error         — could not reach the terminal; retry allowed.
 */
export type ChargePhase =
  | "idle"
  | "present_card"
  | "cancelling"
  | "approved"
  | "partial"
  | "declined"
  | "cancelled"
  | "indeterminate"
  | "error";

export type ChargeView = {
  phase: ChargePhase;
  tone: "ok" | "info" | "warn" | "bad";
  message: string;
};

/** The panel after a payment call answered. */
export function chargeView(result: PaymentResult): ChargeView {
  const p = result.payment;
  switch (p.state) {
    case "approved": {
      const paid = result.order?.state === "paid";
      if (!paid && p.requested_amount !== null && p.amount < p.requested_amount) {
        return {
          phase: "partial",
          tone: "warn",
          message: `Partial approval: ${money(p.amount)} of ${money(p.requested_amount)} captured. Collect the remaining ${money(result.order?.totals.due)} on another payment.`,
        };
      }
      return paid
        ? {
            phase: "approved",
            tone: "ok",
            message: `${p.number} approved — ${money(p.amount)}. Paid in full.`,
          }
        : {
            phase: "approved",
            tone: "ok",
            message: `${p.number} approved — ${money(p.amount)}. ${money(result.order?.totals.due)} still due.`,
          };
    }
    case "declined":
      return {
        phase: "declined",
        tone: "bad",
        message: `Declined: ${p.decline_reason || p.message || "the bank declined the card"}. Try again or another tender.`,
      };
    case "cancelled":
      return { phase: "cancelled", tone: "info", message: "Cancelled. Nothing was charged." };
    case "indeterminate":
      return {
        phase: "indeterminate",
        tone: "warn",
        message: `The terminal did not confirm ${p.number}. Check its status — do not charge again until it is resolved.`,
      };
    case "error":
      return {
        phase: "error",
        tone: "bad",
        message: `Could not reach the terminal${p.message ? ` (${p.message})` : ""}. Nothing was charged; retry.`,
      };
    case "pending":
      return { phase: "present_card", tone: "info", message: "Present card on the terminal." };
    default:
      return { phase: "idle", tone: "info", message: `${p.number} is ${p.state}.` };
  }
}

/** Why Charge is unavailable for this cart, or null when the cashier may charge. */
export function chargeBlocker(cart: Cart | null): string | null {
  if (!cart) return "Find the customer and load what they owe.";
  if (cart.state !== "open") return `${cart.number} is ${cart.state}.`;
  if (cart.lines.length === 0) return "The cart is empty.";
  if (cart.blocking_payment_id) {
    const p = cart.payments.find((x) => x.id === cart.blocking_payment_id);
    return `${p?.number ?? "A payment"} is still ${p?.state ?? "unresolved"} — check its status first.`;
  }
  if (cart.totals.due < 0) return "This cart is a credit; refund at the register instead.";
  return null;
}

/** Lines may change only while no payment is live on the cart (the server enforces it too). */
export function cartLocked(cart: Cart | null): boolean {
  if (!cart || cart.state !== "open") return true;
  return cart.payments.some((p) => ["pending", "indeterminate", "approved"].includes(p.state));
}

/** Validates the Charge form before it is sent; null when it can go. */
export function chargeInputError(input: {
  amount: string;
  due: number;
  tender: TenderType;
  terminalId: string;
  tenderRef: string;
  reason: string;
}): string | null {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount < 0 || Math.round(amount * 100) !== amount * 100) {
    return "Enter an amount in dollars and cents.";
  }
  if (amount > input.due + 1e-9) return `At most ${money(input.due)} is due.`;
  if (amount === 0 && (input.due !== 0 || input.tender === "card")) return "Nothing to charge.";
  if (input.tender === "card" && !input.terminalId) return "Choose the card terminal.";
  if ((input.tender === "check" || input.tender === "external") && !input.tenderRef.trim()) {
    return input.tender === "check"
      ? "Enter the check number."
      : "Enter the external terminal's reference.";
  }
  if (input.tender === "comp" && !input.reason.trim()) return "A COMP needs a reason.";
  return null;
}

/** A payment a manager may void / refund from the register. */
export function reversible(p: CartPayment): boolean {
  return p.state === "approved";
}

/** A payment the cashier must resolve before charging again. */
export function unresolved(p: CartPayment): boolean {
  return p.state === "pending" || p.state === "indeterminate";
}

export function paymentLabel(p: CartPayment): string {
  const card = p.card_last4 ? ` ${p.card_brand ?? "card"} ••${p.card_last4}` : "";
  const tender = p.tender === "card" ? card.trim() || "card" : TENDER_LABELS[p.tender];
  const reversed = p.reversed_amount ? ` (${money(p.reversed_amount)} back)` : "";
  return `${p.number} · ${tender} · ${money(p.amount)} · ${p.state}${reversed}`;
}
