"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import QRCode from "qrcode";
import { encode } from "rules";
import type { StationSession } from "@/components/intake/use-station-session";
import { loadReceipt, printSettlementReceipt, type SettlementReceipt } from "./allocate-data";
import { BOX_METHOD_LABELS, money } from "./allocate-state";

/**
 * Per-angler settlement receipt with the boxing QR (FL:BOX:<token>, packages/rules qr.ts) that
 * opens this angler at boxing. Lines sum to the stored total. Prints from the browser, or
 * queues a receipt print job on the counter printer.
 */
export function SettlementReceiptView({
  session,
  settlementId,
}: {
  session: StationSession;
  settlementId: string;
}) {
  const [receipt, setReceipt] = useState<SettlementReceipt | null>(null);
  const [qr, setQr] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let live = true;
    loadReceipt(session.client, settlementId).then(
      async (r) => {
        const url = await QRCode.toDataURL(encode("BOX", { token: r.boxing_token }), {
          margin: 1,
          width: 220,
        });
        if (live) {
          setReceipt(r);
          setQr(url);
        }
      },
      () => live && setMessage("Receipt unavailable."),
    );
    return () => {
      live = false;
    };
  }, [session.client, settlementId]);

  if (!receipt) return <section className="station-card">{message || "Loading…"}</section>;
  const priced = receipt.session_state === "priced" || receipt.session_state === "done";
  const lines = [
    [
      `Processing share (${receipt.split_method === "even" ? "even split" : `${receipt.weight_total_lb} lb by weight`})`,
      receipt.processing_share,
    ],
    [`Boxes (${receipt.boxes.length})`, receipt.box_fee_total],
    ...(Number(receipt.freight_total) > 0
      ? [["Freight", receipt.freight_total] as [string, number]]
      : []),
  ] as [string, number][];

  return (
    <section className="station-card allocate-receipt" aria-label={`Receipt ${receipt.number}`}>
      <h2>
        Settlement {receipt.number} · {receipt.session_number}
      </h2>
      <p>
        {receipt.angler_name}
        {receipt.party_name && ` · party of ${receipt.party_name}`} · {receipt.date}
        {receipt.state === "paid" && " · PAID"}
      </p>
      {!priced && <p role="alert">Not priced yet — price the session before handing this out.</p>}
      <table className="intake-price-lines">
        <tbody>
          {lines.map(([label, amount]) => (
            <tr key={label}>
              <td>{label}</td>
              <td>{money(Number(amount))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="intake-total">Total {money(Number(receipt.amount_total))}</p>
      {receipt.retail_note && <p>Retail: {receipt.retail_note}</p>}
      <h3>Take-home</h3>
      <ul>
        {receipt.species.map((s) => (
          <li key={`${s.species}/${s.method}`}>
            {s.species} {s.method} — {s.lb} lb
          </li>
        ))}
      </ul>
      <h3>Boxes</h3>
      <ul>
        {receipt.boxes.map((b) => (
          <li key={b.number}>
            {b.number} · {BOX_METHOD_LABELS[b.method]} · {b.size ?? "no size"} · {b.weight_lb} lb
            {b.heavy && " · HEAVY"}
          </li>
        ))}
      </ul>
      {/* eslint-disable-next-line @next/next/no-img-element -- data URL rendered locally */}
      {qr && <img src={qr} width={220} height={220} alt="Boxing QR" data-qr-kind="BOX" />}
      <p className="station-hint">Show this code at boxing / will-call.</p>
      {message && <p role="status">{message}</p>}
      <div className="station-actions">
        <button type="button" onClick={() => window.print()}>
          Print
        </button>
        <button
          type="button"
          disabled={!priced}
          onClick={() =>
            printSettlementReceipt(session.client, settlementId).then(
              (r) =>
                setMessage(
                  r.printer_missing
                    ? "No receipt printer is set up here; use Print."
                    : "Receipt queued.",
                ),
              (err: unknown) =>
                setMessage(err instanceof Error ? err.message : "Receipt did not queue."),
            )
          }
        >
          Send to receipt printer
        </button>
        <Link href={`/allocate/${receipt.session_id}`}>Back to {receipt.session_number}</Link>
      </div>
    </section>
  );
}
