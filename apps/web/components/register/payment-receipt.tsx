"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useStationSession } from "@/components/intake/use-station-session";
import { paymentReceipt } from "./register-data";
import { money } from "./register-state";

/** payment.receipt as stored at approval (DECISION-13) + the payment's current state. */
export type ReceiptData = {
  org: { name: string; footer: string };
  order_number: string;
  customer: string | null;
  date: string;
  lines: { description: string; qty: number; amount: number }[];
  subtotal: number;
  tax: number;
  tax_setting: { mode: string; rate: number; cap_amount: number | null };
  total: number;
  paid: number;
  due: number;
  payment: {
    number: string;
    amount: number;
    requested_amount: number | null;
    tender: string;
    tender_ref: string | null;
    reason: string | null;
    provider_ref: string | null;
    card_brand: string | null;
    card_last4: string | null;
    entry_mode: string | null;
    auth_code: string | null;
  };
  other_payments: {
    number: string;
    amount: number;
    tender: string;
    card_brand: string | null;
    card_last4: string | null;
  }[];
  state: string;
  reversed_amount: number | null;
  reverse_reason: string | null;
};

const TENDER: Record<string, string> = {
  card: "Card",
  cash: "Cash",
  check: "Check",
  external: "External terminal",
  comp: "COMP",
};

/** The customer receipt, rendered only from the stored snapshot — never from live data. */
export function PaymentReceipt({ receipt }: { receipt: ReceiptData }) {
  const p = receipt.payment;
  return (
    <section className="station-card register-receipt" aria-label="Receipt">
      <h2>{receipt.org.name}</h2>
      <p>
        {receipt.order_number} · {receipt.date}
        {receipt.customer && ` · ${receipt.customer}`}
      </p>
      <table className="intake-price-lines">
        <tbody>
          {receipt.lines.map((l, i) => (
            <tr key={i}>
              <td>
                {l.description}
                {l.qty !== 1 && ` × ${l.qty}`}
              </td>
              <td>{money(l.amount)}</td>
            </tr>
          ))}
          <tr>
            <td>Subtotal</td>
            <td>{money(receipt.subtotal)}</td>
          </tr>
          <tr>
            <td>Tax</td>
            <td>{money(receipt.tax)}</td>
          </tr>
          <tr>
            <td>
              <strong>Total</strong>
            </td>
            <td>
              <strong>{money(receipt.total)}</strong>
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        {p.number} · {TENDER[p.tender] ?? p.tender} {money(p.amount)}
        {p.card_last4 && ` · ${p.card_brand ?? "Card"} ••${p.card_last4}`}
        {p.entry_mode && ` · ${p.entry_mode}`}
        {p.auth_code && ` · Auth ${p.auth_code}`}
        {p.tender_ref && ` · Ref ${p.tender_ref}`}
        {p.tender === "comp" && p.reason && ` · ${p.reason}`}
      </p>
      {receipt.other_payments.map((o) => (
        <p key={o.number}>
          {o.number} · {TENDER[o.tender] ?? o.tender} {money(o.amount)}
          {o.card_last4 && ` · ${o.card_brand ?? "Card"} ••${o.card_last4}`}
        </p>
      ))}
      <p>{receipt.due > 0 ? `Balance due ${money(receipt.due)}` : "Paid in full"}</p>
      {(receipt.reversed_amount ?? 0) > 0 && (
        <p className="station-feedback station-rejected">
          {receipt.state === "voided" || receipt.state === "refunded"
            ? receipt.state.toUpperCase()
            : "PARTIALLY REFUNDED"}{" "}
          {money(receipt.reversed_amount)} — {receipt.reverse_reason}
        </p>
      )}
      {receipt.org.footer && <p>{receipt.org.footer}</p>}
    </section>
  );
}

/** /register/receipt/[paymentId]: print the stored receipt from the browser. */
export function PaymentReceiptStation({ paymentId }: { paymentId: string }) {
  const { session, loaded } = useStationSession();
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!session) return;
    paymentReceipt(session.client, paymentId).then(
      (r) => setReceipt(r as unknown as ReceiptData),
      (err: unknown) => setError(err instanceof Error ? err.message : "Receipt not found"),
    );
  }, [session, paymentId]);

  return (
    <main className="station intake-station register-station">
      {!loaded ? (
        <p>Opening…</p>
      ) : !session ? (
        <p>
          <Link href="/login">Sign in</Link> to print receipts.
        </p>
      ) : error ? (
        <p className="station-feedback station-rejected">{error}</p>
      ) : receipt ? (
        <>
          <PaymentReceipt receipt={receipt} />
          <div className="station-actions">
            <button type="button" onClick={() => window.print()}>
              Print
            </button>
            <Link href="/register">Back to register</Link>
          </div>
        </>
      ) : (
        <p>Loading receipt…</p>
      )}
    </main>
  );
}
