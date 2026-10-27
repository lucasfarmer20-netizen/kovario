// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PaymentReceipt, type ReceiptData } from "./payment-receipt";

afterEach(cleanup);

const RECEIPT: ReceiptData = {
  org: { name: "Register A", footer: "Thanks!" },
  order_number: "REG-0001",
  customer: "Pat Party",
  date: "2026-10-27 11:00",
  lines: [
    { description: "STL-0001 — Pat (ALC-0001)", qty: 1, amount: 40 },
    { description: "Ice pack", qty: 2, amount: 5 },
  ],
  subtotal: 45,
  tax: 2.7,
  tax_setting: { mode: "exclusive", rate: 0.06, cap_amount: 30 },
  total: 47.7,
  paid: 47.7,
  due: 0,
  payment: {
    number: "PAY-0002",
    amount: 27.7,
    requested_amount: 27.7,
    tender: "card",
    tender_ref: null,
    reason: null,
    provider_ref: "abc-2",
    card_brand: "VISA",
    card_last4: "4242",
    entry_mode: "chip",
    auth_code: "OK1234",
  },
  other_payments: [
    { number: "PAY-0001", amount: 20, tender: "cash", card_brand: null, card_last4: null },
  ],
  state: "approved",
  reversed_amount: null,
  reverse_reason: null,
};

it("renders the stored receipt: lines, tax, total, card meta (brand, last4, entry mode, auth), other payments", () => {
  render(<PaymentReceipt receipt={RECEIPT} />);
  expect(screen.getByText("Ice pack × 2")).toBeTruthy();
  expect(screen.getByText("$2.70")).toBeTruthy();
  expect(screen.getByText("$47.70")).toBeTruthy();
  expect(
    screen.getByText("PAY-0002 · Card $27.70 · VISA ••4242 · chip · Auth OK1234"),
  ).toBeTruthy();
  expect(screen.getByText("PAY-0001 · Cash $20.00")).toBeTruthy();
  expect(screen.getByText("Paid in full")).toBeTruthy();
  expect(screen.getByText("Thanks!")).toBeTruthy();
});

it("a reversed payment's receipt says so", () => {
  render(
    <PaymentReceipt
      receipt={{
        ...RECEIPT,
        state: "refunded",
        reversed_amount: 27.7,
        reverse_reason: "wrong card",
      }}
    />,
  );
  expect(screen.getByText("REFUNDED $27.70 — wrong card")).toBeTruthy();
});
