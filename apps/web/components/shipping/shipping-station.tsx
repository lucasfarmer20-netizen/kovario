"use client";
import { StationsLink } from "@/src/components/station/stations-link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { addressLine, walkinParcel, type Address, type Parcel } from "shipping";
import {
  managerElevation,
  useStationSession,
  type StationSession,
} from "@/components/intake/use-station-session";
import { AddressFields } from "./address-fields";
import { ShipmentPanel, type ShipmentActions } from "./shipment-panel";
import * as data from "./shipping-data";
import {
  VIEW_LABELS,
  filterShipments,
  money,
  statusLine,
  type KindFilter,
  type Queue,
  type QueueFilters,
  type QueueView,
  type Shipment,
  type UnassignedGroup,
} from "./shipping-state";

type Mode = "queue" | "walkin" | "ratecheck";

function Shell({
  session,
  mode,
  setMode,
  children,
}: {
  session: StationSession | null;
  mode: Mode;
  setMode: (m: Mode) => void;
  children: ReactNode;
}) {
  const tab = (m: Mode, label: string) => (
    <button type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
      {label}
    </button>
  );
  return (
    <main className="station intake-station shipping-station">
      <header>
        <div>
          <p className="station-eyebrow">Filletry · {session?.siteName ?? "Shipping"}</p>
          <h1>Shipping</h1>
        </div>
        <nav className="station-actions" aria-label="Shipping">
          <StationsLink />
          {tab("queue", "Queue")}
          {tab("walkin", "Walk-in")}
          {tab("ratecheck", "Rate Check")}
        </nav>
      </header>
      {children}
    </main>
  );
}

/** /shipping: the shipping queue (keyboard station). */
export function ShippingStation() {
  const { session, loaded } = useStationSession();
  const [mode, setMode] = useState<Mode>("queue");
  if (!loaded)
    return (
      <Shell session={null} mode={mode} setMode={setMode}>
        Opening shipping…
      </Shell>
    );
  if (!session)
    return (
      <Shell session={null} mode={mode} setMode={setMode}>
        <p>Sign in as staff or pair this computer as a station to ship.</p>
        <div className="station-actions">
          <Link href="/login">Staff sign in</Link>
          <Link href="/pair">Pair device</Link>
        </div>
      </Shell>
    );
  return (
    <Shell session={session} mode={mode} setMode={setMode}>
      {mode === "queue" && <QueueView session={session} />}
      {mode === "walkin" && <WalkinForm session={session} onCreated={() => setMode("queue")} />}
      {mode === "ratecheck" && <RateCheck session={session} />}
    </Shell>
  );
}

function actionsFor(session: StationSession, shipmentId: string): ShipmentActions {
  const c = session.client;
  return {
    update: (shipTo, shipDate) => data.updateShipment(c, shipmentId, shipTo, shipDate),
    verify: async () => (await data.verifyAddress(c, shipmentId)).shipment,
    shop: async () => (await data.shopRates(c, shipmentId)).shipment,
    select: (rateId) => data.selectRate(c, shipmentId, rateId),
    buy: async (token) => {
      const r = await data.buyLabel(c, shipmentId, token);
      if (r.status === "bought") {
        return {
          shipment: r.shipment,
          notice: r.adopted
            ? "Labels fetched (already bought at Shippo — not charged twice)."
            : "Labels bought.",
        };
      }
      return { shipment: await data.loadShipment(c, shipmentId) };
    },
    print: async () => {
      const r = await data.printLabels(c, shipmentId);
      return r.printer_missing
        ? "No shipping-label printer is set up for this site (Admin → Printers)."
        : `${r.jobs} label${r.jobs === 1 ? "" : "s"} sent to the printer.`;
    },
    markShipped: () => data.markShipped(c, shipmentId),
    cancel: (reason, token) => data.cancelShipment(c, shipmentId, reason, token),
    elevate: (pin) => managerElevation(c, pin),
  };
}

function QueueView({ session }: { session: StationSession }) {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [filters, setFilters] = useState<QueueFilters>({ view: "open", kind: "all", q: "" });
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");

  const reload = useCallback(() => {
    data
      .loadQueue(session.client)
      .then(setQueue, () => setError("Shipping queue unavailable; reload."));
  }, [session.client]);
  useEffect(reload, [reload]);

  if (!queue) return <p>{error || "Loading the queue…"}</p>;
  const rows = filterShipments(queue.shipments, filters);
  const current = queue.shipments.find((s) => s.shipment_id === selected) ?? null;

  return (
    <div className="shipping-layout">
      <section className="station-card" aria-label="Shipping queue">
        <div className="intake-fields">
          <label>
            Search
            <input
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
              placeholder="SHP-0001, customer, BOX-0042, tracking"
            />
          </label>
          <label>
            Show
            <select
              value={filters.view}
              onChange={(e) => setFilters({ ...filters, view: e.target.value as QueueView })}
            >
              {Object.entries(VIEW_LABELS).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Kind
            <select
              value={filters.kind}
              onChange={(e) => setFilters({ ...filters, kind: e.target.value as KindFilter })}
            >
              <option value="all">All</option>
              <option value="boxes">Ship boxes</option>
              <option value="walkin">Walk-in</option>
            </select>
          </label>
          <button type="button" onClick={reload}>
            Refresh
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        <ul className="station-queue" aria-label="Shipments">
          {rows.length === 0 && <li>No shipments match.</li>}
          {rows.map((s) => (
            <li key={s.shipment_id}>
              <button
                type="button"
                aria-pressed={selected === s.shipment_id}
                onClick={() => setSelected(s.shipment_id)}
              >
                <strong>{s.number}</strong> ·{" "}
                {(s.angler_name ?? s.customer_name ?? addressLine(s.ship_to)) || "—"} · ships{" "}
                {s.ship_date ?? "—"} · {s.parcels.length} parcel{s.parcels.length === 1 ? "" : "s"}
                {s.is_walkin ? " · walk-in" : ""}
                {s.rate_amount !== null ? ` · ${money(s.rate_amount)}` : ""}
              </button>
              <span className="station-badge">{statusLine(s)}</span>
            </li>
          ))}
        </ul>

        <h2>Ship boxes without a shipment</h2>
        {queue.unassigned.length === 0 ? (
          <p>Every ship box is in a shipment.</p>
        ) : (
          queue.unassigned.map((g) => (
            <NewShipment
              key={g.settlement_id}
              session={session}
              group={g}
              onCreated={(s) => {
                reload();
                setSelected(s.shipment_id);
              }}
            />
          ))
        )}
      </section>

      {current && (
        <ShipmentPanel
          key={`${current.shipment_id}:${current.state}:${current.shippo_rate_id ?? ""}`}
          shipment={current}
          actions={actionsFor(session, current.shipment_id)}
          onChanged={(next) =>
            setQueue(
              (q) =>
                q && {
                  ...q,
                  shipments: q.shipments.map((s) =>
                    s.shipment_id === next.shipment_id ? next : s,
                  ),
                },
            )
          }
        />
      )}
    </div>
  );
}

/** One angler's unassigned ship boxes → a shipment (address + ship date). */
function NewShipment({
  session,
  group,
  onCreated,
}: {
  session: StationSession;
  group: UnassignedGroup;
  onCreated: (s: Shipment) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState(new Set(group.boxes.map((b) => b.box_plan_id)));
  const [shipTo, setShipTo] = useState<Partial<Address>>({ name: group.angler_name });
  const [shipDate, setShipDate] = useState("");
  const [error, setError] = useState("");
  return (
    <article className="shipping-group">
      <p>
        <strong>{group.angler_name}</strong> ({group.settlement_number} · {group.session_number}
        {group.customer_name ? ` · ${group.customer_name}` : ""}) —{" "}
        {group.boxes.map((b) => `${b.number} ${b.weight_lb} lb (${b.state})`).join(", ")}
      </p>
      {!open ? (
        <button type="button" onClick={() => setOpen(true)}>
          Create shipment
        </button>
      ) : (
        <>
          {group.boxes.map((b) => (
            <label key={b.box_plan_id} className="intake-toggle">
              <input
                type="checkbox"
                checked={picked.has(b.box_plan_id)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(b.box_plan_id);
                  else next.delete(b.box_plan_id);
                  setPicked(next);
                }}
              />
              {b.number}
            </label>
          ))}
          <AddressFields
            value={shipTo}
            onChange={setShipTo}
            idPrefix={`new-${group.settlement_id}`}
          />
          <label>
            Ship date
            <input type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} />
          </label>
          <div className="station-actions">
            <button
              type="button"
              disabled={picked.size === 0}
              onClick={() =>
                data
                  .createShipment(session.client, [...picked], shipTo, shipDate || null)
                  .then(onCreated, (e: unknown) =>
                    setError(e instanceof Error ? e.message : "Could not create the shipment"),
                  )
              }
            >
              Create shipment
            </button>
          </div>
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </article>
  );
}

type ParcelDraft = {
  length_in: string;
  width_in: string;
  height_in: string;
  weight_lb: string;
  dry_ice_lb: string;
};
const emptyParcel: ParcelDraft = {
  length_in: "",
  width_in: "",
  height_in: "",
  weight_lb: "",
  dry_ice_lb: "",
};

function toParcels(drafts: ParcelDraft[]): Parcel[] | null {
  const out: Parcel[] = [];
  for (const d of drafts) {
    const p = walkinParcel({
      length_in: Number(d.length_in),
      width_in: Number(d.width_in),
      height_in: Number(d.height_in),
      weight_lb: Number(d.weight_lb),
      dry_ice_lb: Number(d.dry_ice_lb || 0),
    });
    if (!p) return null;
    out.push(p);
  }
  return out;
}

function ParcelFields({
  drafts,
  setDrafts,
}: {
  drafts: ParcelDraft[];
  setDrafts: (d: ParcelDraft[]) => void;
}) {
  return (
    <>
      {drafts.map((d, i) => (
        <div key={i} className="intake-fields" aria-label={`Parcel ${i + 1}`}>
          {(
            [
              ["length_in", "L in"],
              ["width_in", "W in"],
              ["height_in", "H in"],
              ["weight_lb", "Gross lb"],
              ["dry_ice_lb", "Dry ice lb"],
            ] as const
          ).map(([k, label]) => (
            <label key={k}>
              {label}
              <input
                type="number"
                min={0}
                step="0.1"
                className="w-20"
                value={d[k]}
                onChange={(e) =>
                  setDrafts(drafts.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))
                }
              />
            </label>
          ))}
          {drafts.length > 1 && (
            <button type="button" onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}>
              Remove
            </button>
          )}
        </div>
      ))}
      <button type="button" onClick={() => setDrafts([...drafts, emptyParcel])}>
        Add parcel
      </button>
    </>
  );
}

/** A walk-in: the customer's own packed parcels, measured at the desk. */
function WalkinForm({ session, onCreated }: { session: StationSession; onCreated: () => void }) {
  const [shipTo, setShipTo] = useState<Partial<Address>>({});
  const [shipDate, setShipDate] = useState("");
  const [drafts, setDrafts] = useState<ParcelDraft[]>([emptyParcel]);
  const [error, setError] = useState("");
  return (
    <section className="station-card" aria-label="Walk-in shipment">
      <h2>Walk-in shipment</h2>
      <AddressFields value={shipTo} onChange={setShipTo} idPrefix="walkin" />
      <label>
        Ship date
        <input type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} />
      </label>
      <h3>Parcels</h3>
      <ParcelFields drafts={drafts} setDrafts={setDrafts} />
      <div className="station-actions">
        <button
          type="button"
          onClick={() => {
            const parcels = toParcels(drafts);
            if (!parcels) return setError("Every parcel needs L, W, H and a weight above 0.");
            data
              .createWalkin(session.client, null, shipTo, shipDate || null, parcels)
              .then(onCreated, (e: unknown) =>
                setError(e instanceof Error ? e.message : "Could not create the walk-in"),
              );
          }}
        >
          Create walk-in shipment
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

/**
 * Rate Check: quote any address and parcels from this site — every carrier (bypasses the
 * allowlist), or allowlisted only for a freight quote. Nothing is stored or bought.
 */
function RateCheck({ session }: { session: StationSession }) {
  const [to, setTo] = useState<Partial<Address>>({});
  const [drafts, setDrafts] = useState<ParcelDraft[]>([emptyParcel]);
  const [allCarriers, setAllCarriers] = useState(true);
  const [result, setResult] = useState<Awaited<ReturnType<typeof data.rateCheck>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section className="station-card" aria-label="Rate Check">
      <h2>Rate Check</h2>
      <AddressFields value={to} onChange={setTo} idPrefix="ratecheck" />
      <ParcelFields drafts={drafts} setDrafts={setDrafts} />
      <label>
        <input
          type="checkbox"
          checked={allCarriers}
          onChange={(e) => setAllCarriers(e.target.checked)}
        />{" "}
        Every carrier (bypass the allowlist) — untick for the freight quote
      </label>
      <div className="station-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            const parcels = toParcels(drafts);
            if (!parcels) return setError("Every parcel needs L, W, H and a weight above 0.");
            setBusy(true);
            setError("");
            data
              .rateCheck(session.client, to as Address, parcels, allCarriers)
              .then(setResult, (e: unknown) =>
                setError(e instanceof Error ? e.message : "Rate check failed"),
              )
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Checking…" : "Check rates"}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          {result.cheapest && (
            <p>
              Freight quote: <strong>{money(result.cheapest.amount)}</strong> (
              {result.cheapest.provider} {result.cheapest.service})
            </p>
          )}
          {result.missingCarriers.length > 0 && (
            <p role="alert">No answer from {result.missingCarriers.join(", ")}.</p>
          )}
          <ul className="station-queue" aria-label="Quoted rates">
            {result.rates.map((r) => (
              <li key={r.rateId}>
                {r.provider} {r.service} · {money(r.amount)}
                {r.estimatedDays ? ` · ${r.estimatedDays} d` : ""}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
