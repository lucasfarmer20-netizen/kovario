"use client";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { statusPageUrl } from "rules";
import { useStationSession } from "./use-station-session";
import { loadIntake } from "./intake-data";

type Receipt = {
  name: string;
  number: string;
  estimatedPickup: string | null;
  timezone: string;
  hours: string;
  notice: string;
  qr: string;
  url: string;
  charges: {
    id: string;
    description: string | null;
    qty: number;
    unit_price: number;
    amount: number;
  }[];
};
const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

export function IntakeReceipt({ intakeId }: { intakeId: string }) {
  const { session, loaded } = useStationSession();
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!session) return;
    let live = true;
    void (async () => {
      const [{ data: org, error: orgError }, detail, estimate] = await Promise.all([
        session.client
          .from("org")
          .select("name,slug,settings,timezone")
          .eq("id", session.claims.orgId)
          .single(),
        loadIntake(session.client, intakeId),
        session.client.rpc("intake_pickup_estimate", { p_intake_id: intakeId }),
      ]);
      if (orgError || estimate.error || !org || !detail.intake)
        throw new Error("Receipt unavailable");
      const settings = org.settings as {
        pickup_hours?: string;
        rates_notice?: string;
        receipt_footer?: string;
      };
      const url = statusPageUrl(org.slug);
      const qr = await QRCode.toDataURL(url, { width: 200 });
      if (live)
        setReceipt({
          name: org.name,
          number: detail.intake.number,
          estimatedPickup: estimate.data,
          timezone: org.timezone,
          hours: settings.pickup_hours ?? "Contact the plant",
          notice: settings.rates_notice || settings.receipt_footer || "",
          qr,
          url,
          charges: detail.charges
            .filter((c) => c.state !== "voided")
            .map((c) => ({ ...c, amount: c.amount ?? 0 })),
        });
    })().catch(() => {
      if (live) setError(true);
    });
    return () => {
      live = false;
    };
  }, [session, intakeId]);
  if (loaded && !session) return <p>Sign in or use a paired station to view a receipt.</p>;
  if (error) return <p>Receipt unavailable.</p>;
  if (!receipt) return <p>Loading receipt…</p>;
  return (
    <main className="mx-auto max-w-xl space-y-4 p-6">
      <button className="min-h-14 rounded border p-3 print:hidden" onClick={() => window.print()}>
        Print receipt
      </button>
      <h1 className="text-2xl font-semibold">
        {receipt.name} · {receipt.number}
      </h1>
      <p>
        Estimated pickup:{" "}
        {receipt.estimatedPickup
          ? new Date(receipt.estimatedPickup).toLocaleString("en-US", {
              timeZone: receipt.timezone,
            })
          : "Ask the plant"}
      </p>
      <table className="w-full">
        <thead>
          <tr>
            <th>Service</th>
            <th>Quantity</th>
            <th>Rate</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {receipt.charges.map((c) => (
            <tr key={c.id}>
              <td>{c.description}</td>
              <td>{c.qty}</td>
              <td>{money(c.unit_price)}</td>
              <td>{money(c.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>Pickup hours: {receipt.hours}</p>
      <p>{receipt.notice}</p>
      {/* A local data URL must retain the exact QR pixels for printing. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={receipt.qr}
        width={200}
        height={200}
        alt="Scan to check your fish status"
        data-qr={receipt.url}
      />
      <a className="underline" href={receipt.url}>
        {receipt.url}
      </a>
    </main>
  );
}
