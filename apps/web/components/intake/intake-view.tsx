"use client";
import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import {
  Calculator,
  CircleCheck,
  ExternalLink,
  Inbox,
  LockOpen,
  Minus,
  Plus,
  Printer,
  ReceiptText,
  ShieldAlert,
  Trash2,
  UserRound,
} from "lucide-react";
import { FRESH, formatPhone, type IntakeDraft } from "rules";
import type { CustomerHit } from "@/components/customers/customer-search-state";
import { StationShell } from "@/src/components/station/station-shell";
import { DisabledReason } from "@/src/components/station/next-step";
import { OrderTile } from "@/src/components/station/order-tile";
import { StationNotice } from "@/src/components/station/notice";
import { Tick } from "@/src/components/station/tick";
import type { PriceContext } from "./intake-data";
import {
  conditionOptions,
  lineGap,
  linesPrompt,
  methodOptions,
  money,
  parseToteCount,
  skinOffAllowed,
  speciesOptions,
  STATE_LABELS,
  type LineRow,
  type OrgReference,
} from "./intake-form-state";

/** The station's name in the console bar (docs/11: the Intake station keeps its name). */
export const INTAKE_STATION = "Intake";
export const INTAKE_STEPS = ["Find the customer", "Add species lines", "Save & print"] as const;

export type Prompt = { next: string; step?: number; tone?: "warn" };

/**
 * The Intake console (docs/06 Intake, docs/12 "Keyboard stations"): the shell without a scanner
 * input, so the keyboard stays in the form; New Intake and Orders sit in the console bar.
 */
export function IntakeShell({
  site,
  operator,
  prompt,
  steps = true,
  status,
  online,
  children,
}: {
  site: string;
  operator: string | null;
  prompt: Prompt;
  /** false: a screen with no steps (the order list). */
  steps?: boolean;
  status: ReactNode;
  online?: boolean;
  children: ReactNode;
}) {
  return (
    <StationShell
      name={INTAKE_STATION}
      site={site}
      operator={operator}
      pending={0}
      scanner={false}
      online={online}
      next={prompt.next}
      nextTone={prompt.tone}
      steps={steps ? INTAKE_STEPS : undefined}
      step={prompt.step}
      status={status}
      nav={
        <>
          <Link href="/intake">New Intake</Link>
          <Link href="/intakes">Orders</Link>
        </>
      }
    >
      {children}
    </StationShell>
  );
}

export type Draft = IntakeDraft | { error: string } | null;

/**
 * The next step line, current step and Save's reason (docs/11 grammar): find the customer, then
 * fill each line (naming the field it still needs), then Save. A rule the price can't be built
 * under, or a rate the card is missing, warns and holds Save; offline, Save waits and says so.
 */
export function intakeNextStep(f: {
  customer: boolean;
  rows: LineRow[];
  toteCount: string;
  /** The rate card has loaded. */
  priced: boolean;
  draft: Draft;
  online: boolean;
}): Prompt & { step: number; saveWhy: string | null } {
  if (!f.customer)
    return { next: "Find the customer by phone", step: 0, saveWhy: "Pick the customer first" };
  const gap = linesPrompt(f.rows);
  if (gap) return { next: gap, step: 1, saveWhy: `${gap} first` };
  if (!parseToteCount(f.toteCount))
    return { next: "Enter the tote count", step: 1, saveWhy: "Enter the tote count (1 to 99)" };
  if (f.draft && "error" in f.draft)
    return { next: f.draft.error, step: 1, tone: "warn", saveWhy: "Change the line first" };
  if (f.draft && f.draft.missingRates.length > 0) {
    const list = f.draft.missingRates.join(", ");
    return {
      next: `No rate for ${list}. Ask a manager to add it to the rate card.`,
      step: 2,
      tone: "warn",
      saveWhy: `The rate card has no rate for ${list}`,
    };
  }
  const save = "Tap Save & Print Tote Tags";
  if (!f.priced || !f.draft) return { next: save, step: 2, saveWhy: "Loading rates" };
  if (!f.online)
    return { next: save, step: 2, saveWhy: "Needs a connection. The order stays as typed." };
  return { next: save, step: 2, saveWhy: null };
}

/** A refusal in the docs/11 grammar: what happened, then what to do. */
export function refusal(message: string, todo: string): string {
  const why = message.trim().replace(/\.$/, "");
  return `${why}. ${todo}`;
}

/**
 * Step 1 of a keyboard station: the customer search (phone first) until one is picked, then the
 * customer's name, phone and lodge, with Change customer. Intake and Storage intake.
 */
export function CustomerCard({
  customer,
  search,
  onChange,
}: {
  customer: CustomerHit | null;
  search: ReactNode;
  onChange: () => void;
}) {
  return (
    <section className="station-card" aria-label="Customer">
      <h2>Customer</h2>
      {customer ? (
        <div className="st-item-head">
          <div>
            <p className="st-customer-name">
              <strong>{customer.name}</strong>
            </p>
            <ul className="st-facts" aria-label="Customer details">
              <li className="st-num">
                {customer.phone ? formatPhone(customer.phone) : "No phone"}
              </li>
              {customer.is_lodge_guest && (
                <li>Lodge{customer.lodge_name ? ` · ${customer.lodge_name}` : ""}</li>
              )}
            </ul>
          </div>
          <button type="button" className="st-btn-secondary" onClick={onChange}>
            Change customer
          </button>
        </div>
      ) : (
        search
      )}
    </section>
  );
}

export type IntakeFormValues = {
  customer: CustomerHit | null;
  rows: LineRow[];
  toteCount: string;
  dirtyFish: boolean;
  dirtyNotes: string;
  cutNotes: string;
  processingNotes: string;
  fastPass: boolean;
  printReceipt: boolean;
};

export type IntakeFormViewProps = {
  /** The species and rate card: null while the first load is on its way. */
  reference: OrgReference | null;
  ctx: PriceContext | null;
  draft: Draft;
  values: IntakeFormValues;
  /** With an order a manager unlocked: its number (the panel says saving locks it again). */
  editing?: string;
  /** The customer search (phone first); shown until a customer is picked. */
  customerSearch: ReactNode;
  saveWhy: string | null;
  saving: boolean;
  /** A field to focus (ids from `fieldId`), e.g. the lb once a line's method is picked. */
  focus?: { id: string; n: number } | null;
  on: {
    changeCustomer: () => void;
    setRow: (key: string, patch: Partial<LineRow>) => void;
    addRow: () => void;
    removeRow: (key: string) => void;
    set: <K extends Exclude<keyof IntakeFormValues, "customer" | "rows">>(
      field: K,
      value: IntakeFormValues[K],
    ) => void;
    save: () => void;
  };
};

/** The id of a line's field, for moving focus to it. */
export const fieldId = (rowKey: string, field: keyof LineRow) => `intake-${rowKey}-${field}`;

/**
 * The Intake form (docs/06 Intake): customer, species lines, totes and notes, with the price and
 * Save in the rail (right of the form on a tablet, under it on a phone). Each line ticks green
 * when complete; disabled fields say what they wait for. Presentational: the live station and
 * the gallery both render it.
 */
export function IntakeFormView(props: IntakeFormViewProps) {
  const { reference, values: v, on, focus } = props;
  useEffect(() => {
    if (focus) document.getElementById(focus.id)?.focus();
  }, [focus]);
  if (!reference) return <IntakeFormSkeleton />;
  const species = speciesOptions(reference);
  return (
    <div className="st-floor" data-rail="end">
      <div className="st-main st-form">
        {props.editing && (
          <section className="station-card st-panel" aria-label="Unlocked">
            <h2 className="st-panel-title">
              <span className="st-panel-icon" aria-hidden>
                <LockOpen size={22} strokeWidth={2.6} />
              </span>
              <span className="st-panel-kicker">UNLOCKED</span>
              <span className="st-sr"> · </span>
              <span className="st-panel-sub">
                Order <span className="st-code">{props.editing}</span>
              </span>
            </h2>
            <p className="st-panel-lead">
              A manager unlocked this order. Change it, then Save & Print Tote Tags locks it again.
            </p>
          </section>
        )}
        <CustomerCard
          customer={v.customer}
          search={props.customerSearch}
          onChange={on.changeCustomer}
        />

        <section className="station-card" aria-label="Species lines">
          <h2 className="st-card-head">
            <span>Species</span>
            <span className="st-count st-num">{v.rows.length}</span>
          </h2>
          <ol className="st-list">
            {v.rows.map((row, i) => {
              const n = i + 1;
              const complete = lineGap(row) === null;
              const conditions = conditionOptions(reference, row.species);
              const methods = methodOptions(reference, row.species, row.condition);
              return (
                <li key={row.key} className="st-line" data-complete={complete || undefined}>
                  <div className="st-line-head">
                    <h3>
                      {complete && <CircleCheck size={22} aria-hidden />}
                      Line {n}
                    </h3>
                    {v.rows.length > 1 && (
                      <button
                        type="button"
                        className="st-btn-danger"
                        aria-label={`Remove line ${n}`}
                        onClick={() => on.removeRow(row.key)}
                      >
                        <Trash2 size={20} aria-hidden />
                        Remove
                      </button>
                    )}
                  </div>
                  <div className="st-fields">
                    <label className="st-field">
                      <span>Species</span>
                      <select
                        id={fieldId(row.key, "species")}
                        aria-label={`Line ${n} species`}
                        value={row.species}
                        onChange={(e) => on.setRow(row.key, { species: e.target.value })}
                      >
                        <option value="">Pick</option>
                        {species.map((o) => (
                          <option key={o.code} value={o.code}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="st-field">
                      <span>Condition</span>
                      <select
                        id={fieldId(row.key, "condition")}
                        aria-label={`Line ${n} condition`}
                        value={row.condition}
                        disabled={!row.species}
                        onChange={(e) => on.setRow(row.key, { condition: e.target.value })}
                      >
                        <option value="">{row.species ? "Pick" : "Species first"}</option>
                        {conditions.map((o) => (
                          <option key={o.code} value={o.code}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="st-field">
                      <span>Method</span>
                      <select
                        id={fieldId(row.key, "method")}
                        aria-label={`Line ${n} method`}
                        value={row.method}
                        disabled={!row.condition}
                        onChange={(e) => on.setRow(row.key, { method: e.target.value })}
                      >
                        <option value="">{row.condition ? "Pick" : "Condition first"}</option>
                        {methods.map((o) => (
                          <option key={o.code} value={o.code}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="st-field">
                      <span>lb</span>
                      <input
                        id={fieldId(row.key, "lb")}
                        aria-label={`Line ${n} lb`}
                        inputMode="decimal"
                        className="st-num"
                        value={row.lb}
                        onChange={(e) => on.setRow(row.key, { lb: e.target.value })}
                      />
                    </label>
                    {row.method === FRESH && (
                      <label className="st-field">
                        <span>Fillets %</span>
                        <input
                          id={fieldId(row.key, "filletsPct")}
                          aria-label={`Line ${n} fillets %`}
                          inputMode="numeric"
                          className="st-num"
                          value={row.filletsPct}
                          onChange={(e) => on.setRow(row.key, { filletsPct: e.target.value })}
                        />
                      </label>
                    )}
                    {skinOffAllowed(row.species) && (
                      <div className="st-field">
                        <Tick
                          label={`Line ${n} skin off`}
                          checked={row.skinOff}
                          onChange={(skinOff) => on.setRow(row.key, { skinOff })}
                        >
                          Skin off
                        </Tick>
                      </div>
                    )}
                    <label className="st-field st-field-span2">
                      <span>Notes</span>
                      <input
                        aria-label={`Line ${n} notes`}
                        value={row.notes}
                        onChange={(e) => on.setRow(row.key, { notes: e.target.value })}
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
              Add line
            </button>
          </div>
        </section>

        <section className="station-card" aria-label="Totes and notes">
          <h2>Totes and notes</h2>
          <div className="st-form">
            <div className="st-fields">
              <div className="st-field">
                <label htmlFor="intake-totes">Totes</label>
                <div className="st-stepper">
                  <button
                    type="button"
                    className="st-btn-secondary"
                    aria-label="Remove a tote"
                    disabled={(parseToteCount(v.toteCount) ?? 1) <= 1}
                    onClick={() =>
                      on.set("toteCount", String((parseToteCount(v.toteCount) ?? 2) - 1))
                    }
                  >
                    <Minus size={22} aria-hidden />
                  </button>
                  <input
                    id="intake-totes"
                    inputMode="numeric"
                    value={v.toteCount}
                    onChange={(e) => on.set("toteCount", e.target.value)}
                  />
                  <button
                    type="button"
                    className="st-btn-secondary"
                    aria-label="Add a tote"
                    disabled={(parseToteCount(v.toteCount) ?? 0) >= 99}
                    onClick={() =>
                      on.set("toteCount", String((parseToteCount(v.toteCount) ?? 0) + 1))
                    }
                  >
                    <Plus size={22} aria-hidden />
                  </button>
                </div>
              </div>
            </div>
            <div className="station-actions">
              <Tick checked={v.dirtyFish} onChange={(on_) => on.set("dirtyFish", on_)}>
                Dirty fish
              </Tick>
              <Tick checked={v.fastPass} onChange={(on_) => on.set("fastPass", on_)}>
                Fast Pass
              </Tick>
            </div>
            <div className="st-fields">
              {v.dirtyFish && (
                <label className="st-field st-field-wide">
                  <span>Dirty notes</span>
                  <input
                    value={v.dirtyNotes}
                    onChange={(e) => on.set("dirtyNotes", e.target.value)}
                  />
                </label>
              )}
              <label className="st-field st-field-wide">
                <span>Cut notes</span>
                <input value={v.cutNotes} onChange={(e) => on.set("cutNotes", e.target.value)} />
              </label>
              <label className="st-field st-field-wide">
                <span>Processing notes</span>
                <input
                  value={v.processingNotes}
                  onChange={(e) => on.set("processingNotes", e.target.value)}
                />
              </label>
            </div>
          </div>
        </section>
      </div>

      <aside className="st-rail" aria-label="Price" aria-live="polite">
        <section className="station-card">
          <PriceSummary ctx={props.ctx} draft={props.draft} fastPass={v.fastPass} />
          <div className="st-commit">
            <Tick checked={v.printReceipt} onChange={(on_) => on.set("printReceipt", on_)}>
              Print receipt too
            </Tick>
            <div>
              <button
                type="button"
                className="st-btn-hero st-btn-block"
                disabled={props.saving || props.saveWhy !== null}
                onClick={on.save}
              >
                <Printer size={26} aria-hidden />
                {props.saving ? "Saving…" : "Save & Print Tote Tags"}
              </button>
              <DisabledReason reason={!props.saving && props.saveWhy} />
            </div>
          </div>
        </section>
      </aside>
    </div>
  );
}

/** The live price (rules engine `buildIntakeDraft`): yield per line, charges, total. */
function PriceSummary({
  ctx,
  draft,
  fastPass,
}: {
  ctx: PriceContext | null;
  draft: Draft;
  fastPass: boolean;
}) {
  return (
    <>
      <h2>Price</h2>
      <p className="st-eyebrow">
        {ctx?.rate_card?.name ?? "No rate card"}
        {fastPass && " · Fast Pass"}
        {!fastPass &&
          ctx?.customer?.is_lodge_guest &&
          ctx.customer.lodge_cap !== null &&
          ` · Lodge cap ${money(ctx.customer.lodge_cap)}/lb`}
      </p>
      {!draft ? (
        <div className="st-empty">
          <Calculator size={32} aria-hidden />
          <p>
            <strong>No price yet</strong>
            <br />
            It shows as soon as a line is complete.
          </p>
        </div>
      ) : "error" in draft ? (
        <StationNotice tone="error" text={draft.error} />
      ) : (
        <>
          <ul className="st-yield" aria-label="Estimated yield">
            {draft.lines.map((l, i) => (
              <li key={i}>{`Line ${i + 1}: ${l.lb} lb → est. ${l.estYieldLb ?? "—"} lb`}</li>
            ))}
          </ul>
          <dl className="st-summary" aria-label="Charges">
            {draft.charges.map((c, i) => (
              <div key={i}>
                <dt>
                  <span>{c.description}</span>
                  <span className="st-summary-sub">
                    {c.qty} lb × {money(c.unitPrice)}/lb
                  </span>
                </dt>
                <dd>{money(c.amount)}</dd>
              </div>
            ))}
          </dl>
          <p className="st-summary-total">Total {money(draft.totalAmount)}</p>
          <p className="st-summary-sub">
            {draft.totalLb} lb in · est. yield {draft.totalEstYieldLb} lb{" "}
            {draft.ribbing && <span className="station-badge st-badge-flag">RIBBING</span>}
          </p>
          {draft.missingRates.length > 0 && (
            <StationNotice tone="error" text={`No rate for ${draft.missingRates.join(", ")}.`} />
          )}
        </>
      )}
    </>
  );
}

/** First load: the form's cards and the price rail as placeholders, so nothing jumps. */
export function IntakeFormSkeleton() {
  return (
    <div className="st-floor" data-rail="end" aria-busy="true">
      <div className="st-main">
        <section className="station-card st-skeleton-stack" aria-label="Opening the order form">
          <div className="st-skeleton" style={{ height: 32, width: "30%" }} aria-hidden />
          <div className="st-skeleton" style={{ height: 56 }} aria-hidden />
        </section>
        <section className="station-card st-skeleton-stack" aria-hidden>
          <div className="st-skeleton" style={{ height: 32, width: "25%" }} />
          <div className="st-skeleton" style={{ height: 140 }} />
        </section>
      </div>
      <aside className="st-rail" aria-hidden>
        <section className="station-card st-skeleton-stack">
          <div className="st-skeleton" style={{ height: 32, width: "40%" }} />
          <div className="st-skeleton" style={{ height: 64 }} />
          <div className="st-skeleton" style={{ height: 72 }} />
        </section>
      </aside>
    </div>
  );
}

/** No session: who is at the desk (docs/12 "Operator needed"), with the two ways in. */
export function SignInNeeded({ what }: { what: string }) {
  return (
    <section className="station-card st-hero-empty" aria-label="Sign in">
      <div className="st-hero-art" aria-hidden>
        <UserRound size={56} strokeWidth={1.6} />
      </div>
      <h2>Sign in to {what}</h2>
      <p>Sign in as staff, or pair this tablet as a station.</p>
      <div className="station-actions">
        <Link href="/login" className="st-link-secondary">
          Staff sign in
        </Link>
        <Link href="/pair" className="st-link-secondary">
          Pair device
        </Link>
      </div>
    </section>
  );
}

/** A saved order, as the saved view shows it (mapped from the DB rows by the station). */
export type SavedIntake = {
  number: string;
  customer: string | null;
  phone: string | null;
  /** State, hours in the cooler, Locked, Lodge: chips. */
  chips: string[];
  /** FAST PASS, DIRTY, RIBBING: badges. */
  flags: string[];
  lines: { id: string; name: string; detail: string; lb: number; estYield: number | null }[];
  totalLb: number;
  totalEstYield: number;
  toteCount: number;
  notes: { label: string; text: string }[];
  charges: {
    id: string;
    description: string | null;
    qty: number;
    unitPrice: number | null;
    amount: number | null;
    state: string;
  }[];
  timeline: { label: string; at: string }[];
  totes: { no: number; of: number; qr: string; queued: boolean }[];
  /** Locked and still in the cooler: a manager can unlock it. */
  canUnlock: boolean;
  receiptHref: string;
};

/** The saved view's next step: tag the totes, or (no tote printer) write the number on them. */
export function savedNextStep(intake: Pick<SavedIntake, "number" | "totes">): Prompt {
  const printed = intake.totes.some((t) => t.queued);
  return printed
    ? { next: "Tag the totes, then tap New Intake", step: INTAKE_STEPS.length }
    : {
        next: `No tote printer here. Write ${intake.number} on each tote.`,
        step: INTAKE_STEPS.length,
        tone: "warn",
      };
}

/**
 * A saved order (docs/06 Intake, after Save & Print Tote Tags): the number as on its tags, the
 * tote tags, then New Intake as the one filled button, with Reprint, Print Receipt and the
 * manager Unlock beside it. Lines, charges and the timeline follow.
 */
export function IntakeSavedView({
  intake,
  busy,
  on,
}: {
  intake: SavedIntake;
  busy: boolean;
  on: { newIntake: () => void; reprint: () => void; printReceipt: () => void; unlock: () => void };
}) {
  const total = intake.charges.reduce((s, c) => s + (c.amount ?? 0), 0);
  return (
    <div className="st-floor" data-rail="end">
      <div className="st-main">
        <section className="station-card st-item" aria-label="Order">
          <div className="st-item-head">
            <div>
              <p className="st-eyebrow">Order</p>
              <h2>
                <span className="st-sr">Order </span>
                <span className="st-hero-number">{intake.number}</span>
              </h2>
              <p className="st-customer-name">
                <strong>{intake.customer}</strong>
                {intake.phone && <span className="st-num"> · {formatPhone(intake.phone)}</span>}
              </p>
            </div>
            <div className="st-order-flags" aria-label="Order state">
              {intake.chips.map((c) => (
                <span key={c} className="station-badge">
                  {c}
                </span>
              ))}
              {intake.flags.map((f) => (
                <span key={f} className="station-badge st-badge-flag">
                  {f}
                </span>
              ))}
            </div>
          </div>
          <div>
            <h3>Tote tags</h3>
            <ul className="st-list" aria-label="Tote tags">
              {intake.totes.map((t) => (
                <li key={t.no} className="st-basket-row">
                  <span className="st-basket-row-main">
                    <span className="st-basket-name">
                      Tote {t.no} of {t.of}
                    </span>
                    <span className="st-basket-row-meta">
                      <code>{t.qr}</code>
                    </span>
                  </span>
                  <span className="st-basket-row-end">
                    {t.queued ? (
                      <>
                        <Printer size={20} aria-hidden /> Queued
                      </>
                    ) : (
                      <span className="station-badge st-badge-manual">Not printed</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="st-commit">
            <button type="button" className="st-btn-hero st-btn-block" onClick={on.newIntake}>
              <Plus size={26} aria-hidden />
              New Intake
            </button>
            <div className="station-actions">
              <button
                type="button"
                className="st-btn-secondary"
                disabled={busy}
                onClick={on.reprint}
              >
                <Printer size={20} aria-hidden />
                Reprint
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
              <Link href={intake.receiptHref} className="st-link-secondary">
                <ExternalLink size={20} aria-hidden />
                Open customer receipt
              </Link>
              {intake.canUnlock && (
                <button
                  type="button"
                  className="st-btn-secondary"
                  disabled={busy}
                  onClick={on.unlock}
                >
                  <ShieldAlert size={20} aria-hidden />
                  Unlock
                </button>
              )}
            </div>
          </div>
        </section>

        <section className="station-card" aria-label="Lines">
          <h2 className="st-card-head">
            <span>Lines</span>
            <span className="st-count st-num">{intake.lines.length}</span>
          </h2>
          <dl className="st-summary">
            {intake.lines.map((l) => (
              <div key={l.id}>
                <dt>
                  <span>{l.name}</span>
                  <span className="st-summary-sub">{l.detail}</span>
                </dt>
                <dd>
                  {l.lb} lb → est. {l.estYield ?? "—"} lb
                </dd>
              </div>
            ))}
          </dl>
          <p className="st-summary-sub">
            {intake.totalLb} lb in · est. yield {intake.totalEstYield} lb · {intake.toteCount}{" "}
            {intake.toteCount === 1 ? "tote" : "totes"}
          </p>
          {intake.notes.length > 0 && (
            <dl className="st-notes">
              {intake.notes.map((n) => (
                <div key={n.label}>
                  <dt>{n.label}</dt>
                  <dd>{n.text}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      </div>

      <aside className="st-rail" aria-label="Charges and timeline">
        <section className="station-card" aria-label="Charges">
          <h2>Charges</h2>
          <dl className="st-summary">
            {intake.charges.map((c) => (
              <div key={c.id}>
                <dt>
                  <span>{c.description}</span>
                  <span className="st-summary-sub">
                    {c.qty} lb × {money(c.unitPrice)}/lb
                    {c.state !== "open" && ` · ${c.state}`}
                  </span>
                </dt>
                <dd>{money(c.amount)}</dd>
              </div>
            ))}
          </dl>
          <p className="st-summary-total">Total {money(total)}</p>
        </section>
        <section className="station-card" aria-label="Timeline">
          <h2>Timeline</h2>
          <dl className="st-summary">
            {intake.timeline.map((e) => (
              <div key={e.label}>
                <dt>{e.label}</dt>
                <dd>
                  <time dateTime={e.at}>{new Date(e.at).toLocaleString()}</time>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </aside>
    </div>
  );
}

/** A saved order's first load: the hero card and rail as placeholders. */
export function IntakeSavedSkeleton() {
  return (
    <div className="st-floor" data-rail="end" aria-busy="true">
      <div className="st-main">
        <section className="station-card st-skeleton-stack" aria-label="Opening the order">
          <div className="st-skeleton" style={{ height: 88, width: "50%" }} aria-hidden />
          <div className="st-skeleton" style={{ height: 76 }} aria-hidden />
          <div className="st-skeleton" style={{ height: 72 }} aria-hidden />
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

export type IntakeListRow = {
  id: string;
  number: string;
  detail: string;
  /** "18h in cooler" while it waits in the cooler. */
  age?: string;
  flags: string[];
};

/** Recent orders, newest first; a state filter; each order a tile that opens it. */
export function IntakeListView({
  rows,
  filter,
  error,
  on,
}: {
  /** null while loading. */
  rows: IntakeListRow[] | null;
  filter: string;
  error: string;
  on: { filter: (state: string) => void; open: (id: string) => void };
}) {
  return (
    <div className="st-floor">
      <div className="st-main">
        <section className="station-card st-form" aria-label="Orders">
          <h2 className="st-card-head">
            <span>Orders</span>
            {rows && <span className="st-count st-num">{rows.length}</span>}
          </h2>
          <div className="st-fields">
            <label className="st-field">
              <span>State</span>
              <select value={filter} onChange={(e) => on.filter(e.target.value)}>
                <option value="">All</option>
                {Object.entries(STATE_LABELS).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
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
              <div className="st-skeleton" />
            </div>
          ) : rows.length === 0 ? (
            <div className="st-empty">
              <Inbox size={32} aria-hidden />
              <p>
                <strong>No orders{filter ? ` ${STATE_LABELS[filter]?.toLowerCase()}` : ""}</strong>
                <br />
                Orders appear here once they are saved at the Intake desk.
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
