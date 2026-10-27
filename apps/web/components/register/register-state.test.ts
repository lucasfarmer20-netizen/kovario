import { describe, expect, it } from "vitest";
import {
  cartLocked,
  chargeBlocker,
  chargeInputError,
  chargeView,
  markable,
  paymentLabel,
  reversalUnresolved,
  reversalView,
  reversible,
  unresolved,
  type Cart,
  type CartPayment,
  type PaymentResult,
} from "./register-state";

const payment = (over: Partial<CartPayment> = {}): CartPayment => ({
  id: "p-1",
  number: "PAY-0001",
  state: "approved",
  provider: "dejavoo_spin",
  amount: 10,
  requested_amount: 10,
  tender: "card",
  tender_ref: null,
  attempt: 1,
  card_brand: "VISA",
  card_last4: "4242",
  entry_mode: "chip",
  auth_code: "A1",
  decline_reason: null,
  message: null,
  reversed_amount: null,
  ...over,
});

const cart = (over: Partial<Cart> = {}): Cart => ({
  id: "o-1",
  number: "REG-0001",
  kind: "sale",
  state: "open",
  customer: { id: "c-1", name: "Pat", phone: null },
  lines: [
    {
      id: "l-1",
      kind: "charge",
      description: "Adjustment CHG-0001",
      qty: 1,
      unit_price: 10,
      amount: 10,
      charge_id: "ch-1",
      settlement_id: null,
      batch_id: null,
      retail_product_id: null,
    },
  ],
  totals: { subtotal: 10, tax: 0.6, total: 10.6, paid: 0, due: 10.6 },
  payments: [],
  blocking_payment_id: null,
  tax_setting: { mode: "exclusive", rate: 0.06, cap_amount: 30 },
  ...over,
});

const result = (p: Partial<CartPayment>, o: Partial<Cart> = {}): PaymentResult => ({
  status: "applied",
  payment: payment(p),
  order: cart(o),
});

describe("WP16 charge flow UI states (docs/05 §2.4)", () => {
  it("approved and paid in full", () => {
    expect(chargeView(result({}, { state: "paid" }))).toMatchObject({
      phase: "approved",
      tone: "ok",
    });
  });

  it("partial approval asks for the remainder on another payment", () => {
    const v = chargeView(
      result(
        { amount: 6, requested_amount: 10 },
        { totals: { subtotal: 10, tax: 0.6, total: 10.6, paid: 6, due: 4.6 } },
      ),
    );
    expect(v.phase).toBe("partial");
    expect(v.message).toContain("Collect the remaining $4.60");
  });

  it("declined shows the bank's reason, never 'cancelled'", () => {
    const v = chargeView(result({ state: "declined", decline_reason: "Insufficient funds" }));
    expect(v).toMatchObject({ phase: "declined", tone: "bad" });
    expect(v.message).toContain("Insufficient funds");
  });

  it("cancelled is quiet; error says the terminal could not be reached", () => {
    expect(chargeView(result({ state: "cancelled" }))).toMatchObject({
      phase: "cancelled",
      tone: "info",
    });
    expect(chargeView(result({ state: "error", message: "timeout" })).message).toMatch(
      /Could not reach the terminal \(timeout\)/,
    );
  });

  it("indeterminate warns never to charge again; pending is 'present card'", () => {
    expect(chargeView(result({ state: "indeterminate" })).message).toMatch(/do not charge again/);
    expect(chargeView(result({ state: "pending" })).phase).toBe("present_card");
    expect(chargeView(result({ state: "voided" })).phase).toBe("idle");
  });
});

describe("what the cashier may do", () => {
  it("Charge is blocked without a cart, on a closed or empty cart, or while a payment is unresolved", () => {
    expect(chargeBlocker(null)).toMatch(/load what they owe/);
    expect(chargeBlocker(cart({ state: "paid" }))).toMatch(/paid/);
    expect(chargeBlocker(cart({ lines: [] }))).toMatch(/empty/);
    expect(
      chargeBlocker(
        cart({ blocking_payment_id: "p-1", payments: [payment({ state: "indeterminate" })] }),
      ),
    ).toMatch(/PAY-0001 is still indeterminate/);
    expect(
      chargeBlocker(cart({ totals: { subtotal: -5, tax: 0, total: -5, paid: 0, due: -5 } })),
    ).toMatch(/credit/);
    expect(
      chargeBlocker(
        cart({
          reversal_payment_id: "p-1",
          payments: [payment({ reverse_pending_kind: "refund", reverse_unresolved: true })],
        }),
      ),
    ).toMatch(/PAY-0001 has a refund in progress or unconfirmed/);
    expect(chargeBlocker(cart())).toBeNull();
  });

  it("the cart is locked once a payment is live on it", () => {
    expect(cartLocked(cart())).toBe(false);
    expect(cartLocked(cart({ payments: [payment({ state: "declined" })] }))).toBe(false);
    expect(cartLocked(cart({ payments: [payment({ state: "approved" })] }))).toBe(true);
    expect(cartLocked(cart({ state: "paid" }))).toBe(true);
    expect(cartLocked(null)).toBe(true);
  });

  it("validates the Charge form", () => {
    const base = {
      amount: "10.60",
      due: 10.6,
      tender: "card" as const,
      terminalId: "t-1",
      tenderRef: "",
      reason: "",
    };
    expect(chargeInputError(base)).toBeNull();
    expect(chargeInputError({ ...base, amount: "1.005" })).toMatch(/dollars and cents/);
    expect(chargeInputError({ ...base, amount: "11" })).toMatch(/At most \$10.60/);
    expect(chargeInputError({ ...base, terminalId: "" })).toMatch(/terminal/);
    expect(chargeInputError({ ...base, amount: "0" })).toMatch(/Nothing to charge/);
    expect(chargeInputError({ ...base, tender: "check" })).toMatch(/check number/);
    expect(chargeInputError({ ...base, tender: "external" })).toMatch(/reference/);
    expect(chargeInputError({ ...base, tender: "comp" })).toMatch(/reason/);
    expect(chargeInputError({ ...base, tender: "cash", amount: "0", due: 0 })).toBeNull();
  });

  it("only approved payments are reversible; pending / indeterminate are unresolved", () => {
    expect(reversible(payment())).toBe(true);
    expect(reversible(payment({ state: "refunded" }))).toBe(false);
    expect(reversible(payment({ reverse_pending_kind: "refund" }))).toBe(false);
    expect(reversalUnresolved(payment({ reverse_pending_kind: "refund" }))).toBe(false);
    expect(
      reversalUnresolved(payment({ reverse_pending_kind: "refund", reverse_unresolved: true })),
    ).toBe(true);
    expect(unresolved(payment({ state: "pending" }))).toBe(true);
    expect(unresolved(payment({ state: "indeterminate" }))).toBe(true);
    expect(unresolved(payment())).toBe(false);
  });

  it("labels a payment with its tender and card", () => {
    expect(paymentLabel(payment())).toBe("PAY-0001 · VISA ••4242 · $10.00 · approved");
    expect(
      paymentLabel(
        payment({ tender: "cash", card_last4: null, state: "refunded", reversed_amount: 10 }),
      ),
    ).toBe("PAY-0001 · Cash · $10.00 · refunded ($10.00 back)");
  });
});

describe("void / refund result (success from the provider's answer, not the payment state)", () => {
  it("a partial refund is a success; the retained balance is shown", () => {
    const v = reversalView(
      "refund",
      {
        status: "refunded",
        payment: payment({ state: "approved", reversed_amount: 2, refundable: 8 }),
        refund_order: { refund_amount: 2 },
      },
      2,
    );
    expect(v.tone).toBe("ok");
    expect(v.message).toBe(
      "PAY-0001: $2.00 returned (refunded). $8.00 is still captured. Nothing is released by a refund.",
    );
  });

  it("a full refund / void reports the total returned", () => {
    expect(
      reversalView("reverse", {
        status: "voided",
        payment: payment({ state: "voided", reversed_amount: 10, refundable: 0 }),
        refund_order: { refund_amount: 10 },
      }).message,
    ).toBe(
      "PAY-0001 voided: $10.00 returned, $10.00 back in total. Nothing is released by a refund.",
    );
  });

  it("declined / error are failures with nothing returned", () => {
    const v = reversalView("refund", { status: "declined", payment: payment({ refundable: 10 }) });
    expect(v.tone).toBe("bad");
    expect(v.message).toBe(
      "PAY-0001: the provider did not refund it (declined). Nothing was returned; $10.00 is still captured.",
    );
  });

  it("indeterminate warns the money may be back; a replay says not to repeat it", () => {
    expect(reversalView("refund", { status: "indeterminate", payment: payment() }).message).toMatch(
      /may already be back/,
    );
    expect(reversalView("refund", { status: "replayed", payment: payment() })).toMatchObject({
      tone: "info",
      message: expect.stringMatching(/already recorded .* Do not repeat it/),
    });
  });
});

describe("manager mark (docs/05 §2.4) never races a sale still on the terminal", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  it("indeterminate can be marked at once", () => {
    expect(markable(payment({ state: "indeterminate" }), now)).toBe(true);
  });
  it("pending only once older than the in-flight window (6 min)", () => {
    expect(markable(payment({ state: "pending", created_at: "2026-10-27T11:58:00Z" }), now)).toBe(
      false,
    );
    expect(markable(payment({ state: "pending", created_at: "2026-10-27T11:53:00Z" }), now)).toBe(
      true,
    );
    expect(markable(payment({ state: "pending" }), now)).toBe(false);
  });
  it("settled payments are never marked", () => {
    expect(markable(payment({ state: "approved" }), now)).toBe(false);
  });
});
