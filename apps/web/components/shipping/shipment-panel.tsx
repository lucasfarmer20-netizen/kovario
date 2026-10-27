"use client";
import { useState } from "react";
import { addressLine, type Address } from "shipping";
import { ManagerPinOverlay, type PinResult } from "@/src/components/station/pin-overlay";
import { AddressFields } from "./address-fields";
import { blockerLabel, money, statusLine, type Shipment } from "./shipping-state";

/** Everything the panel can do; the station wires these to SQL and /api/shipping. */
export type ShipmentActions = {
  update: (shipTo: Partial<Address>, shipDate: string | null) => Promise<Shipment>;
  verify: () => Promise<Shipment>;
  shop: () => Promise<Shipment>;
  select: (rateId: string) => Promise<Shipment>;
  /** `elevationToken` = manager Buy Now (I14). Resolves to the shipment, or held/blockers. */
  buy: (elevationToken: string | null) => Promise<{ shipment?: Shipment; notice?: string }>;
  print: () => Promise<string>;
  markShipped: () => Promise<Shipment>;
  cancel: (reason: string, elevationToken: string | null) => Promise<Shipment>;
  /** Manager PIN → elevation token, or the reason it was refused. */
  elevate: (pin: string) => Promise<{ token: string } | { reason: string }>;
};

type PinFor = { kind: "buy" } | { kind: "cancel"; reason: string };

export function ShipmentPanel({
  shipment: initial,
  actions,
  onChanged,
}: {
  shipment: Shipment;
  actions: ShipmentActions;
  onChanged: (s: Shipment) => void;
}) {
  const [s, setS] = useState(initial);
  const [shipTo, setShipTo] = useState<Partial<Address>>(initial.ship_to);
  const [shipDate, setShipDate] = useState(initial.ship_date ?? "");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [pinFor, setPinFor] = useState<PinFor | null>(null);
  const editable = s.state === "draft" || s.state === "held";

  function show(next: Shipment) {
    setS(next);
    setShipTo(next.ship_to);
    setShipDate(next.ship_date ?? "");
    onChanged(next);
  }

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy("");
    }
  }

  async function buy(token: string | null) {
    const r = await actions.buy(token);
    if (r.shipment) show(r.shipment);
    if (r.notice) setMessage(r.notice);
  }

  const gate = s.gate;
  const rates = s.rate_shop?.rates ?? [];

  return (
    <section className="station-card shipping-panel" aria-label={`Shipment ${s.number}`}>
      <header>
        <h2>
          {s.number} {s.is_walkin && <span className="station-badge">walk-in</span>}
        </h2>
        <p>
          {s.angler_name ?? s.customer_name ?? "—"}
          {s.session_number ? ` · ${s.session_number}` : ""} · {s.parcels.length} parcel
          {s.parcels.length === 1 ? "" : "s"}
        </p>
        <p role="status" className="shipping-status">
          {statusLine(s)}
        </p>
        {editable && gate.blockers.length > 0 && (
          <ul aria-label="Blockers">
            {gate.blockers.map((b) => (
              <li key={b}>{blockerLabel(b)}</li>
            ))}
          </ul>
        )}
        {s.buy_error && <p role="alert">Last buy: {s.buy_error}</p>}
      </header>

      <h3>Ship to</h3>
      {editable ? (
        <>
          <AddressFields value={shipTo} onChange={setShipTo} />
          <label>
            Ship date
            <input type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} />
          </label>
          <div className="station-actions">
            <button
              type="button"
              disabled={!!busy || !!s.rate_lock}
              onClick={() =>
                void run("save", async () => show(await actions.update(shipTo, shipDate || null)))
              }
            >
              Save address & date
            </button>
            <button
              type="button"
              disabled={!!busy || !!s.rate_lock}
              onClick={() =>
                void run("verify", async () => {
                  const next = await actions.verify();
                  show(next);
                  setMessage(
                    next.address_check?.valid
                      ? "Address verified."
                      : "The carrier could not verify this address.",
                  );
                })
              }
            >
              Verify address
            </button>
          </div>
          {s.address_check && !s.address_check.valid && (
            <ul aria-label="Address problems">
              {s.address_check.messages.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p>
          {addressLine(s.ship_to)} · ships {s.ship_date ?? "—"}
        </p>
      )}

      <h3>Parcels</h3>
      <ul className="station-queue">
        {s.parcels.map((p) => (
          <li key={p.parcel_id}>
            {p.box_number ?? `Parcel ${p.seq + 1}`} · {p.weight_lb} lb
            {p.box_size ? ` · ${p.box_size}` : ""}
            {p.box_state ? ` · ${p.box_state}` : ""}
            {p.tracking_number ? ` · ${p.tracking_number}` : ""}
            {p.tracking_status ? ` (${p.tracking_status.toLowerCase()})` : ""}
          </li>
        ))}
      </ul>

      {editable && (
        <>
          <h3>Rate</h3>
          {s.rate_lock && <p role="alert">Rate fixed: {s.rate_lock}</p>}
          <div className="station-actions">
            <button
              type="button"
              disabled={!!busy || !!s.rate_lock}
              onClick={() => void run("shop", async () => show(await actions.shop()))}
            >
              {busy === "shop" ? "Shopping rates…" : rates.length ? "Re-shop rates" : "Shop rates"}
            </button>
          </div>
          {s.rate_shop && s.rate_shop.missingCarriers.length > 0 && (
            <p role="alert">
              No answer from {s.rate_shop.missingCarriers.join(", ")} after {s.rate_shop.attempts}{" "}
              tries — shop again to include them.
            </p>
          )}
          {s.rate_shop?.carrierMessages.map((m) => (
            <p key={m.carrier}>
              {m.carrier}: {m.text}
            </p>
          ))}
          {rates.length > 0 && (
            <ul className="station-queue" aria-label="Rates">
              {rates.map((r) => (
                <li key={r.rateId}>
                  <label>
                    <input
                      type="radio"
                      name={`rate-${s.shipment_id}`}
                      checked={s.shippo_rate_id === r.rateId}
                      disabled={!!busy || !!s.rate_lock}
                      onChange={() =>
                        void run("select", async () => show(await actions.select(r.rateId)))
                      }
                    />
                    {r.provider} {r.service} · {money(r.amount)}
                    {r.estimatedDays
                      ? ` · ${r.estimatedDays} day${r.estimatedDays === 1 ? "" : "s"}`
                      : ""}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="station-actions">
            <button
              type="button"
              disabled={!!busy || !gate.can_buy}
              onClick={() => void run("buy", () => buy(null))}
            >
              {busy === "buy" ? "Buying…" : `Buy label${s.parcels.length > 1 ? "s" : ""}`}
            </button>
            {gate.held && (
              <button type="button" disabled={!!busy} onClick={() => setPinFor({ kind: "buy" })}>
                Buy Now (manager)
              </button>
            )}
          </div>
        </>
      )}

      {(s.state === "label_bought" || s.state === "shipped") && (
        <>
          <h3>
            Label · {s.carrier} {s.service} · {money(s.rate_amount)}
          </h3>
          <div className="station-actions">
            <button
              type="button"
              disabled={!!busy || !gate.can_reprint}
              onClick={() => void run("print", async () => setMessage(await actions.print()))}
            >
              {s.parcels.some((p) => p.label_printed_at) ? "Reprint labels" : "Print labels"}
            </button>
            {s.state === "label_bought" && (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void run("ship", async () => show(await actions.markShipped()))}
              >
                Mark shipped
              </button>
            )}
          </div>
        </>
      )}

      {s.state !== "shipped" && s.state !== "cancelled" && (
        <details>
          <summary>Cancel shipment</summary>
          <label>
            Reason
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button
            type="button"
            disabled={!!busy || !reason.trim()}
            onClick={() =>
              s.state === "label_bought"
                ? setPinFor({ kind: "cancel", reason })
                : void run("cancel", async () => show(await actions.cancel(reason, null)))
            }
          >
            Cancel {s.number}
            {s.state === "label_bought" ? " (manager — refund the label in Shippo)" : ""}
          </button>
        </details>
      )}

      {s.notes && <pre className="shipping-notes">{s.notes}</pre>}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}

      {pinFor && (
        <ManagerPinOverlay
          onClose={() => setPinFor(null)}
          verify={async (pin): Promise<PinResult> => {
            const elevation = await actions.elevate(pin);
            if ("reason" in elevation) return { ok: false, reason: elevation.reason };
            try {
              if (pinFor.kind === "buy") await buy(elevation.token);
              else show(await actions.cancel(pinFor.reason, elevation.token));
            } catch (e) {
              return { ok: false, reason: e instanceof Error ? e.message : "Failed" };
            }
            return { ok: true };
          }}
        />
      )}
    </section>
  );
}
