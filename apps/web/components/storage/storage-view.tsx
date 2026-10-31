"use client";
import type { ReactNode } from "react";
import Link from "next/link";
import {
  Boxes,
  CircleCheck,
  Inbox,
  Plus,
  Printer,
  ReceiptText,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { StationShell } from "@/src/components/station/station-shell";
import { DisabledReason } from "@/src/components/station/next-step";
import { OrderTile } from "@/src/components/station/order-tile";
import { StationNotice } from "@/src/components/station/notice";
import { Tick } from "@/src/components/station/tick";
import { money } from "@/components/intake/intake-form-state";
import { CustomerCard, type Prompt } from "@/components/intake/intake-view";
import type { CustomerHit } from "@/components/customers/customer-search-state";
import type { PickupReceipt, Quote } from "./storage-data";
import { STORAGE_STATE_LABELS, daysLabel, type BoxRow } from "./storage-state";

export const STORAGE_STATION = "Cold storage";
export const STORAGE_STEPS = ["Find the customer", "Add boxes", "Confirm & print"] as const;
export const PICKUP_STEPS = [
  "Tick boxes",
  "Create pickup batch",
  "Charge at the register",
] as const;

/**
 * The Cold storage console (docs/06 Storage intake, docs/12 "Keyboard stations"): the shell
 * without a scanner input; New Storage and Storage Queue sit in the console bar. `className`
 * keeps the receipt print rules (storage-station).
 */
export function StorageShell({
  site,
  operator,
  prompt,
  steps,
  status,
  online,
  children,
}: {
  site: string;
  operator: string | null;
  prompt: Prompt;
  /** The screen's steps: the new storage form's, the pickup's, or none (the queue). */
  steps?: readonly string[];
  status: ReactNode;
  online?: boolean;
  children: ReactNode;
}) {
  return (
    <StationShell
      name={STORAGE_STATION}
      site={site}
      operator={operator}
      pending={0}
      scanner={false}
      online={online}
      next={prompt.next}
      nextTone={prompt.tone}
      steps={steps}
      step={prompt.step}
      status={status}
      className="storage-station"
      nav={
        <>
          <Link href="/storage">New Storage</Link>
          <Link href="/storage/queue">Storage Queue</Link>
        </>
      }
    >
      {children}
    </StationShell>
  );
}

const labelsName = (n: number) => `Confirm & Print ${n} Label${n === 1 ? "" : "s"}`;

/**
 * The new storage form's next step (docs/11 grammar): find the customer, enter the boxes, then
 * Confirm. A box weight that is not a number warns and holds Confirm; offline, Confirm waits.
 * Weights, descriptions and the location stay optional, as confirm_storage_intake takes them.
 */
export function storageNextStep(f: {
  customer: boolean;
  location: boolean;
  rows: BoxRow[];
  /** confirmPayload's problems, without the customer one (step 1 says that). */
  problems: string[];
  online: boolean;
}): Prompt & { step: number; confirmWhy: string | null } {
  if (!f.customer)
    return { next: "Find the customer by phone", step: 0, confirmWhy: "Pick the customer first" };
  if (f.problems.length > 0)
    return { next: f.problems[0]!, step: 1, tone: "warn", confirmWhy: "Fix the box first" };
  const entered = f.rows.some((r) => r.weight.trim() || r.description.trim());
  const confirm = `Tap ${labelsName(f.rows.length)}`;
  const why = f.online ? null : "Needs a connection. The boxes stay as typed.";
  if (!entered && !f.location)
    return { next: "Pick the location, then enter each box", step: 1, confirmWhy: why };
  return { next: confirm, step: 2, confirmWhy: why };
}

export type StorageFormValues = {
  customer: CustomerHit | null;
  locationId: string;
  rows: BoxRow[];
  notes: string;
};

/**
 * Storage intake (docs/06): customer, then where it goes and its boxes (weight, description),
 * notes, and Confirm & Print in the rail with the labels it prints. Presentational: the live
 * station and the gallery both render it.
 */
export function StorageFormView({
  loading,
  locations,
  values: v,
  customerSearch,
  confirmWhy,
  saving,
  on,
}: {
  loading: boolean;
  locations: { id: string; code: string }[];
  values: StorageFormValues;
  customerSearch: ReactNode;
  confirmWhy: string | null;
  saving: boolean;
  on: {
    changeCustomer: () => void;
    location: (id: string) => void;
    setRow: (key: string, patch: Partial<BoxRow>) => void;
    addRow: () => void;
    removeRow: (key: string) => void;
    notes: (value: string) => void;
    confirm: () => void;
  };
}) {
  if (loading) return <StorageSkeleton />;
  const code = locations.find((l) => l.id === v.locationId)?.code;
  return (
    <div className="st-floor" data-rail="end">
      <div className="st-main st-form">
        <CustomerCard customer={v.customer} search={customerSearch} onChange={on.changeCustomer} />
        <section className="station-card" aria-label="Boxes">
          <h2 className="st-card-head">
            <span>Boxes</span>
            <span className="st-count st-num">{v.rows.length}</span>
          </h2>
          <div className="st-form">
            <div className="st-fields">
              <label className="st-field st-field-span2">
                <span>Location</span>
                <select
                  id={LOCATION_FIELD_ID}
                  value={v.locationId}
                  onChange={(e) => on.location(e.target.value)}
                >
                  <option value="">Not placed yet</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.code}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <ol className="st-list">
              {v.rows.map((row, i) => {
                const n = i + 1;
                const entered =
                  Boolean(row.weight.trim() || row.description.trim()) && boxWeight(row) !== false;
                return (
                  <li key={row.key} className="st-line" data-complete={entered || undefined}>
                    <div className="st-line-head">
                      <h3>
                        {entered && <CircleCheck size={22} aria-hidden />}
                        Box {n}
                      </h3>
                      {v.rows.length > 1 && (
                        <button
                          type="button"
                          className="st-btn-danger"
                          aria-label={`Remove box ${n}`}
                          onClick={() => on.removeRow(row.key)}
                        >
                          <Trash2 size={20} aria-hidden />
                          Remove
                        </button>
                      )}
                    </div>
                    <div className="st-fields">
                      <label className="st-field">
                        <span>Weight lb</span>
                        <input
                          id={boxFieldId(row.key)}
                          aria-label={`Box ${n} weight`}
                          inputMode="decimal"
                          className="st-num"
                          value={row.weight}
                          onChange={(e) => on.setRow(row.key, { weight: e.target.value })}
                        />
                      </label>
                      <label className="st-field st-field-span2">
                        <span>Description</span>
                        <input
                          aria-label={`Box ${n} description`}
                          value={row.description}
                          onChange={(e) => on.setRow(row.key, { description: e.target.value })}
                        />
                      </label>
                    </div>
                  </li>
                );
              })}
            </ol>
            <div className="st-finish">
              <button type="button" className="st-btn-secondary" onClick={on.addRow}>
                <Plus size={20} aria-hidden />
                Add box
              </button>
            </div>
            <label className="st-field">
              <span>Notes</span>
              <textarea value={v.notes} onChange={(e) => on.notes(e.target.value)} />
            </label>
          </div>
        </section>
      </div>

      <aside className="st-rail" aria-label="Labels">
        <section className="station-card">
          <h2>Labels</h2>
          <p className="st-eyebrow">{code ? `Location ${code}` : "Not placed yet"}</p>
          <dl className="st-summary" aria-label="Box labels">
            {v.rows.map((row, i) => (
              <div key={row.key}>
                <dt>
                  <span>Box {i + 1}</span>
                  <span className="st-summary-sub">
                    {row.description.trim() || "No description"}
                  </span>
                </dt>
                <dd>{typeof boxWeight(row) === "number" ? `${boxWeight(row)} lb` : "—"}</dd>
              </div>
            ))}
          </dl>
          {!code && (
            <p className="st-summary-sub">Locate places it later; the labels print either way.</p>
          )}
          <div className="st-commit">
            <div>
              <button
                type="button"
                className="st-btn-hero st-btn-block"
                disabled={saving || confirmWhy !== null}
                onClick={on.confirm}
              >
                <Printer size={26} aria-hidden />
                {saving ? "Confirming…" : labelsName(v.rows.length)}
              </button>
              <DisabledReason reason={!saving && confirmWhy} />
            </div>
          </div>
        </section>
      </aside>
    </div>
  );
}

/** A box's weight as typed: the number, null when blank, false when it is not a weight. */
function boxWeight(row: BoxRow): number | null | false {
  const raw = row.weight.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : false;
}

/** The location field's id: the keyboard goes there once the customer is picked. */
export const LOCATION_FIELD_ID = "storage-location";

/** The id of a box's weight field, for moving focus to a box just added. */
export const boxFieldId = (rowKey: string) => `storage-${rowKey}-weight`;

/** First load: the form's cards and the rail as placeholders, so nothing jumps. */
export function StorageSkeleton() {
  return (
    <div className="st-floor" data-rail="end" aria-busy="true">
      <div className="st-main">
        <section className="station-card st-skeleton-stack" aria-label="Opening storage">
          <div className="st-skeleton" style={{ height: 32, width: "30%" }} aria-hidden />
          <div className="st-skeleton" style={{ height: 56 }} aria-hidden />
        </section>
        <section className="station-card st-skeleton-stack" aria-hidden>
          <div className="st-skeleton" style={{ height: 120 }} />
        </section>
      </div>
      <aside className="st-rail" aria-hidden>
        <section className="station-card st-skeleton-stack">
          <div className="st-skeleton" style={{ height: 64 }} />
          <div className="st-skeleton" style={{ height: 72 }} />
        </section>
      </aside>
    </div>
  );
}

/** A storage order as the pickup screen shows it (mapped from the DB rows by the station). */
export type StorageOrder = {
  number: string;
  customer: string | null;
  phone: string | null;
  /** State, the box rollup, location, Paid: chips. */
  chips: string[];
  notes: string | null;
};
export type StorageBox = {
  id: string;
  label: string;
  stored: boolean;
  weight: number | null;
  description: string | null;
  days: number | null;
  /** The text in its label's QR (packages/rules qr.ts). */
  qr: string;
};
export type StorageBatch = {
  id: string;
  number: string;
  /** storage_pickup_batch.state: pending, released, void. */
  code: string;
  /** The state in words ("Awaiting payment"). */
  state: string;
  releaseFailed: boolean;
  boxes: string;
  amount: number;
  paymentRef: string | null;
  notes: string | null;
};
/** A manager release being prepared: Force Release ("manual") or COMP, with its reason. */
export type StorageRelease = {
  number: string;
  amount: number;
  mode: "manual" | "comp";
  reason: string;
};

/** The pickup's next step (docs/11): tick boxes → create the batch → charge at the register. */
export function pickupNextStep(selected: number, pendingBatch: boolean): Prompt & { step: number } {
  if (selected > 0) return { next: "Tap Create Pickup Batch", step: 1 };
  if (pendingBatch) return { next: "Charge the pickup at the register", step: 2 };
  return { next: "Tick each box going home", step: 0 };
}

/**
 * A storage order (docs/06 Storage intake, then pickup): the number as on its box labels, its
 * boxes as whole-row ticks (days stored from the storage_box_days view), the server's quote for
 * the ticked ones and Create Pickup Batch; batches with Receipt, Cancel and the manager Force
 * Release / COMP, whose reason panel takes the top of the work area.
 */
export function StorageDetailView({
  order,
  boxes,
  selected,
  quote,
  batches,
  release,
  receipt,
  manual,
  busy,
  on,
}: {
  order: StorageOrder;
  boxes: StorageBox[];
  selected: string[];
  /** The quote for the current selection; null while it is priced. */
  quote: Quote | null;
  batches: StorageBatch[];
  release: StorageRelease | null;
  receipt: PickupReceipt | null;
  /** Enter manually for a box code (the field reads STG-0001-2). */
  manual: ReactNode;
  busy: boolean;
  on: {
    toggle: (boxId: string, stored: boolean) => void;
    createBatch: () => void;
    reprintLabels: () => void;
    printReceipt: () => void;
    receipt: (batchId: string) => void;
    closeReceipt: () => void;
    cancelBatch: (batchId: string) => void;
    startRelease: (batchId: string, mode: "manual" | "comp") => void;
    releaseReason: (reason: string) => void;
    confirmRelease: () => void;
    cancelRelease: () => void;
  };
}) {
  return (
    <div className="st-floor" data-rail="end">
      <div className="st-main">
        {release && (
          <form
            className="station-card st-panel"
            aria-label={release.mode === "comp" ? "COMP batch" : "Force Release batch"}
            onSubmit={(e) => {
              e.preventDefault();
              on.confirmRelease();
            }}
          >
            <h2 className="st-panel-title">
              <span className="st-panel-icon" aria-hidden>
                <ShieldAlert size={22} strokeWidth={2.6} />
              </span>
              <span className="st-panel-kicker">
                {release.mode === "comp" ? "COMP" : "FORCE RELEASE"}
              </span>
              <span className="st-sr"> · </span>
              <span className="st-panel-sub">
                <span className="st-code">{release.number}</span>
                {release.mode === "comp" && ` · waive ${money(release.amount)}`}
              </span>
            </h2>
            <p className="st-panel-lead">
              {release.mode === "comp"
                ? "Releases the boxes with nothing to pay. A manager PIN confirms it."
                : "Releases the boxes without a register payment. A manager PIN confirms it."}
            </p>
            <label className="st-note st-form">
              Reason
              <input
                autoFocus
                value={release.reason}
                onChange={(e) => on.releaseReason(e.target.value)}
              />
            </label>
            <div className="station-actions">
              <button type="submit" disabled={!release.reason.trim()}>
                <ShieldAlert size={20} aria-hidden />
                Manager PIN…
              </button>
              <button type="button" className="st-btn-secondary" onClick={on.cancelRelease}>
                Back
              </button>
            </div>
            <DisabledReason reason={!release.reason.trim() && "Enter a reason first"} />
          </form>
        )}
        <section className="station-card st-item" aria-label="Storage order header">
          <div className="st-item-head">
            <div>
              <p className="st-eyebrow">Storage order</p>
              <h2>
                <span className="st-hero-number">{order.number}</span>
              </h2>
              <p className="st-customer-name">
                <strong>{order.customer}</strong>
                {order.phone && <span className="st-num"> · {order.phone}</span>}
              </p>
            </div>
            <div className="st-order-flags" aria-label="Order state">
              {order.chips.map((c) => (
                <span key={c} className="station-badge">
                  {c}
                </span>
              ))}
            </div>
          </div>
          {order.notes && (
            <dl className="st-notes">
              <div>
                <dt>Notes</dt>
                <dd>{order.notes}</dd>
              </div>
            </dl>
          )}
          <div className="station-actions">
            <button
              type="button"
              className="st-btn-secondary"
              disabled={busy}
              onClick={on.reprintLabels}
            >
              <Printer size={20} aria-hidden />
              Reprint Labels
            </button>
            <button
              type="button"
              className="st-btn-secondary"
              disabled={busy}
              onClick={on.printReceipt}
            >
              <ReceiptText size={20} aria-hidden />
              Print Receipt
            </button>
            <Link href="/storage" className="st-link-secondary">
              <Plus size={20} aria-hidden />
              New Storage
            </Link>
          </div>
        </section>

        <section className="station-card" aria-label="Boxes">
          <h2 className="st-card-head">
            <span>Boxes</span>
            <span className="st-count st-num">{boxes.length}</span>
          </h2>
          {manual}
          <ul className="st-list">
            {boxes.map((b) => (
              <li key={b.id}>
                <Tick
                  row
                  label={`Pick up ${b.label}`}
                  checked={selected.includes(b.id)}
                  disabled={!b.stored || busy}
                  onChange={() => on.toggle(b.id, b.stored)}
                  meta={
                    <>
                      {b.weight === null ? "No weight" : `${b.weight} lb`}
                      {b.description && ` · ${b.description}`} · <code>{b.qr}</code>
                    </>
                  }
                  end={b.days === null ? "—" : <span className="st-num">{daysLabel(b.days)}</span>}
                >
                  {b.stored ? b.label : `${b.label} · picked up`}
                </Tick>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <aside className="st-rail" aria-label="Pickup">
        <section className="station-card" aria-label="Pickup quote">
          <h2>Pickup</h2>
          {selected.length === 0 ? (
            <div className="st-empty">
              <Boxes size={32} aria-hidden />
              <p>
                <strong>No boxes ticked</strong>
                <br />
                Tick the boxes going home today; the price shows here.
              </p>
            </div>
          ) : quote ? (
            <>
              <dl className="st-summary">
                {quote.boxes.map((l) => (
                  <div key={l.box_id}>
                    <dt>
                      <span>{l.label}</span>
                      <span className="st-summary-sub">
                        {daysLabel(l.days)} × {money(quote.rate)}/box-day
                      </span>
                    </dt>
                    <dd>{money(l.amount)}</dd>
                  </div>
                ))}
              </dl>
              <p className="st-summary-total">Total {money(quote.amount)}</p>
              <p className="st-summary-sub">{quote.box_days} box-days</p>
            </>
          ) : (
            <div className="st-skeleton-stack" aria-label="Pricing">
              <div className="st-skeleton" style={{ height: 48 }} aria-hidden />
              <div className="st-skeleton" style={{ height: 44, width: "60%" }} aria-hidden />
            </div>
          )}
          <div>
            <button
              type="button"
              className="st-btn-hero st-btn-block"
              disabled={busy || !quote || selected.length === 0}
              onClick={on.createBatch}
            >
              Create Pickup Batch
            </button>
            <DisabledReason
              reason={selected.length === 0 ? "Tick a box first" : !quote && "Pricing the boxes"}
            />
          </div>
        </section>

        <section className="station-card" aria-label="Pickup batches">
          <h2 className="st-card-head">
            <span>Pickup batches</span>
            <span className="st-count st-num">{batches.length}</span>
          </h2>
          {batches.length === 0 ? (
            <div className="st-empty">
              <Inbox size={32} aria-hidden />
              <p>
                <strong>No pickups yet</strong>
                <br />A batch is charged at the register, then its boxes are released.
              </p>
            </div>
          ) : (
            <ul className="st-list">
              {batches.map((b) => (
                <li key={b.id} className="st-line">
                  <div className="st-line-head">
                    <h3 className="st-code">{b.number}</h3>
                    <span className="station-badge">{b.state}</span>
                    {b.releaseFailed && (
                      <span className="station-badge st-badge-hold">RELEASE FAILED</span>
                    )}
                  </div>
                  <p className="st-summary-sub">
                    {b.boxes} · {money(b.amount)}
                    {b.paymentRef && ` · Ref ${b.paymentRef}`}
                  </p>
                  <div className="station-actions">
                    <button
                      type="button"
                      className="st-btn-secondary"
                      disabled={busy}
                      onClick={() => on.receipt(b.id)}
                    >
                      Receipt
                    </button>
                    {b.code === "pending" && !b.releaseFailed && (
                      <button
                        type="button"
                        className="st-btn-danger"
                        disabled={busy}
                        onClick={() => on.cancelBatch(b.id)}
                      >
                        Cancel
                      </button>
                    )}
                    {b.code !== "released" && (
                      <>
                        <button
                          type="button"
                          className="st-btn-secondary"
                          disabled={busy}
                          onClick={() => on.startRelease(b.id, "manual")}
                        >
                          Force Release
                        </button>
                        <button
                          type="button"
                          className="st-btn-secondary"
                          disabled={busy}
                          onClick={() => on.startRelease(b.id, "comp")}
                        >
                          COMP
                        </button>
                      </>
                    )}
                  </div>
                  {b.notes && <pre className="storage-notes">{b.notes}</pre>}
                </li>
              ))}
            </ul>
          )}
        </section>

        {receipt && (
          <section
            className="station-card storage-receipt"
            aria-label={`Receipt ${receipt.number}`}
          >
            <h3>
              Receipt {receipt.number} · {receipt.storage_number} · {receipt.date}
            </h3>
            <dl className="st-summary">
              {receipt.lines.map((l) => (
                <div key={l.box_id}>
                  <dt>
                    <span>{l.label}</span>
                    <span className="st-summary-sub">
                      {daysLabel(l.days)} × {money(l.rate)}/box-day
                    </span>
                  </dt>
                  <dd>{money(l.amount)}</dd>
                </div>
              ))}
            </dl>
            <p className="st-summary-total">
              Total {money(receipt.total)}
              {receipt.payment_ref && ` · ${receipt.payment_ref}`}
            </p>
            <div className="station-actions">
              <button type="button" onClick={() => window.print()}>
                <Printer size={20} aria-hidden />
                Print
              </button>
              <button type="button" className="st-btn-secondary" onClick={on.closeReceipt}>
                <X size={20} aria-hidden />
                Close
              </button>
            </div>
          </section>
        )}
      </aside>
    </div>
  );
}

/** A storage order's first load: the hero card and the rail as placeholders. */
export function StorageDetailSkeleton() {
  return (
    <div className="st-floor" data-rail="end" aria-busy="true">
      <div className="st-main">
        <section className="station-card st-skeleton-stack" aria-label="Opening the storage order">
          <div className="st-skeleton" style={{ height: 88, width: "50%" }} aria-hidden />
          <div className="st-skeleton" style={{ height: 56 }} aria-hidden />
        </section>
        <section className="station-card st-skeleton-list" aria-hidden>
          <div className="st-skeleton" />
          <div className="st-skeleton" />
        </section>
      </div>
      <aside className="st-rail" aria-hidden>
        <section className="station-card st-skeleton-stack">
          <div className="st-skeleton" style={{ height: 120 }} />
        </section>
      </aside>
    </div>
  );
}

export type StorageQueueRow = {
  id: string;
  number: string;
  detail: string;
  age?: string;
  flags: string[];
};

/** Storage orders oldest first, a state filter, each order a tile that opens it. */
export function StorageQueueView({
  rows,
  filter,
  error,
  on,
}: {
  rows: StorageQueueRow[] | null;
  filter: string;
  error: string;
  on: { filter: (state: string) => void; open: (id: string) => void };
}) {
  return (
    <div className="st-floor">
      <div className="st-main">
        <section className="station-card st-form" aria-label="Storage queue">
          <h2 className="st-card-head">
            <span>Storage queue</span>
            {rows && <span className="st-count st-num">{rows.length}</span>}
          </h2>
          <div className="st-fields">
            <label className="st-field">
              <span>Show</span>
              <select value={filter} onChange={(e) => on.filter(e.target.value)}>
                <option value="">In storage (stored + partial)</option>
                {(["stored", "partial", "released", "cancelled"] as const).map((code) => (
                  <option key={code} value={code}>
                    {STORAGE_STATE_LABELS[code]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error && <StationNotice tone="error" text={error} />}
          {!rows ? (
            <div className="st-skeleton-list" aria-hidden>
              <div className="st-skeleton" />
              <div className="st-skeleton" />
            </div>
          ) : rows.length === 0 ? (
            <div className="st-empty">
              <Inbox size={32} aria-hidden />
              <p>
                <strong>Nothing in storage</strong>
                <br />
                Storage orders appear here once confirmed at New Storage.
              </p>
            </div>
          ) : (
            <ul className="st-list">
              {rows.map((r) => (
                <li key={r.id}>
                  <OrderTile
                    number={r.number}
                    detail={r.detail}
                    age={r.age}
                    flags={r.flags}
                    onOpen={() => on.open(r.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
