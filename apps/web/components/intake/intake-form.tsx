"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { FRESH, buildIntakeDraft, formatPhone, savePayload, type IntakeDraft } from "rules";
import { CustomerSearch } from "@/components/customers/customer-search";
import type { CustomerHit } from "@/components/customers/customer-search-state";
import {
  createCustomer,
  loadPriceContext,
  loadReference,
  pricingFrom,
  saveIntake,
  searchCustomers,
  type PriceContext,
  type SaveResult,
} from "./intake-data";
import {
  conditionOptions,
  emptyRow,
  methodOptions,
  money,
  parseToteCount,
  rowsToLines,
  skinOffAllowed,
  speciesOptions,
  updateRow,
  type LineRow,
  type OrgReference,
} from "./intake-form-state";
import type { StationSession } from "./use-station-session";

export type IntakeFormInitial = {
  intakeId: string;
  customer: CustomerHit;
  rows: LineRow[];
  toteCount: number;
  dirtyFish: boolean;
  dirtyNotes: string;
  cutNotes: string;
  processingNotes: string;
  fastPass: boolean;
};

/**
 * Intake form (docs/06-STATIONS-UX.md Intake): customer → species lines → totes → notes →
 * Fast Pass → live price panel → Save & Print Tote Tags. With `initial` it edits an
 * intake a manager unlocked; saving locks it again.
 */
export function IntakeForm({
  session,
  initial,
  onSaved,
}: {
  session: StationSession;
  initial?: IntakeFormInitial;
  onSaved: (result: SaveResult) => void;
}) {
  const { client, claims } = session;
  const [ref, setRef] = useState<OrgReference | null>(null);
  const [customer, setCustomer] = useState<CustomerHit | null>(initial?.customer ?? null);
  const [ctx, setCtx] = useState<PriceContext | null>(null);
  const [rows, setRows] = useState<LineRow[]>(initial?.rows ?? [emptyRow()]);
  const [toteCount, setToteCount] = useState(String(initial?.toteCount ?? 1));
  const [dirtyFish, setDirtyFish] = useState(initial?.dirtyFish ?? false);
  const [dirtyNotes, setDirtyNotes] = useState(initial?.dirtyNotes ?? "");
  const [cutNotes, setCutNotes] = useState(initial?.cutNotes ?? "");
  const [processingNotes, setProcessingNotes] = useState(initial?.processingNotes ?? "");
  const [fastPass, setFastPass] = useState(initial?.fastPass ?? false);
  const [printReceipt, setPrintReceipt] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // One id per save intent: a retry after a lost response replays; any edit starts a new one.
  const actionId = useRef<string | null>(null);
  const intakeId = initial?.intakeId ?? null;

  useEffect(() => {
    loadReference(client).then(setRef, () => setError("Reference data unavailable; reload."));
  }, [client]);
  useEffect(() => {
    loadPriceContext(client, customer?.id ?? null, intakeId).then(setCtx, () =>
      setError("Rates unavailable; reload."),
    );
  }, [client, customer?.id, intakeId]);

  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      actionId.current = null;
      setError("");
      set(v);
    };
  const setRow = (key: string, patch: Partial<LineRow>) =>
    edit(setRows)(rows.map((r) => (r.key === key && ref ? updateRow(ref, r, patch) : r)));

  const parsed = useMemo(() => rowsToLines(rows), [rows]);
  const draft = useMemo((): IntakeDraft | { error: string } | null => {
    if (!ctx || parsed.lines.length === 0) return null;
    try {
      return buildIntakeDraft(parsed.lines, pricingFrom(ctx, fastPass));
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Line not allowed" };
    }
  }, [ctx, parsed.lines, fastPass]);

  async function save() {
    const totes = parseToteCount(toteCount);
    const problems = [
      ...(customer ? [] : ["Pick or create the customer."]),
      ...parsed.errors,
      ...(totes ? [] : ["Enter the tote count (1 or more)."]),
      ...(draft && "error" in draft ? [draft.error] : []),
      ...(draft && "missingRates" in draft && draft.missingRates.length > 0
        ? [`The rate card has no rate for ${draft.missingRates.join(", ")}.`]
        : []),
    ];
    if (problems.length > 0 || !customer || !totes) {
      setError(problems.join(" "));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const payload = savePayload(
        {
          intakeId,
          customerId: customer.id,
          toteCount: totes,
          dirtyFish,
          dirtyNotes,
          cutNotes,
          processingNotes,
          fastPass,
          printReceipt,
        },
        parsed.lines,
      );
      actionId.current ??= crypto.randomUUID();
      const result = await saveIntake(client, actionId.current, payload);
      actionId.current = null;
      onSaved(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed; try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!ref) return <p>Loading species…</p>;
  const species = speciesOptions(ref);

  return (
    <div className="station-workspace intake-workspace">
      <section className="station-card intake-form" aria-label="Intake">
        <h2>{intakeId ? "Edit intake" : "New intake"}</h2>
        {customer ? (
          <div className="intake-customer">
            <div>
              <strong>{customer.name}</strong>{" "}
              {customer.phone && <span>{formatPhone(customer.phone)}</span>}{" "}
              {customer.is_lodge_guest && (
                <span className="station-badge">
                  Lodge{customer.lodge_name ? ` · ${customer.lodge_name}` : ""}
                </span>
              )}
            </div>
            <button type="button" onClick={() => edit(setCustomer)(null)}>
              Change customer
            </button>
          </div>
        ) : (
          <CustomerSearch
            autoFocus
            label="Customer phone or name"
            search={(q) => searchCustomers(client, claims.orgId, q)}
            create={(input) => createCustomer(client, input)}
            onSelect={edit(setCustomer)}
          />
        )}

        <h3>Species</h3>
        <table className="intake-lines">
          <thead>
            <tr>
              <th>Species</th>
              <th>Condition</th>
              <th>Method</th>
              <th>lb</th>
              <th>Fillets %</th>
              <th>Skin off</th>
              <th>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.key}>
                <td>
                  <select
                    aria-label={`Line ${i + 1} species`}
                    value={row.species}
                    onChange={(e) => setRow(row.key, { species: e.target.value })}
                  >
                    <option value="">—</option>
                    {species.map((o) => (
                      <option key={o.code} value={o.code}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    aria-label={`Line ${i + 1} condition`}
                    value={row.condition}
                    disabled={!row.species}
                    onChange={(e) => setRow(row.key, { condition: e.target.value })}
                  >
                    <option value="">—</option>
                    {conditionOptions(ref, row.species).map((o) => (
                      <option key={o.code} value={o.code}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    aria-label={`Line ${i + 1} method`}
                    value={row.method}
                    disabled={!row.condition}
                    onChange={(e) => setRow(row.key, { method: e.target.value })}
                  >
                    <option value="">—</option>
                    {methodOptions(ref, row.species, row.condition).map((o) => (
                      <option key={o.code} value={o.code}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    aria-label={`Line ${i + 1} lb`}
                    inputMode="decimal"
                    size={6}
                    value={row.lb}
                    onChange={(e) => setRow(row.key, { lb: e.target.value })}
                  />
                </td>
                <td>
                  {row.method === FRESH && (
                    <input
                      aria-label={`Line ${i + 1} fillets %`}
                      inputMode="numeric"
                      size={4}
                      value={row.filletsPct}
                      onChange={(e) => setRow(row.key, { filletsPct: e.target.value })}
                    />
                  )}
                </td>
                <td>
                  {skinOffAllowed(row.species) && (
                    <input
                      type="checkbox"
                      aria-label={`Line ${i + 1} skin off`}
                      checked={row.skinOff}
                      onChange={(e) => setRow(row.key, { skinOff: e.target.checked })}
                    />
                  )}
                </td>
                <td>
                  <input
                    aria-label={`Line ${i + 1} notes`}
                    value={row.notes}
                    onChange={(e) => setRow(row.key, { notes: e.target.value })}
                  />
                </td>
                <td>
                  {rows.length > 1 && (
                    <button
                      type="button"
                      aria-label={`Remove line ${i + 1}`}
                      onClick={() => edit(setRows)(rows.filter((r) => r.key !== row.key))}
                    >
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" onClick={() => edit(setRows)([...rows, emptyRow()])}>
          Add line
        </button>

        <div className="intake-fields">
          <label>
            Totes
            <input
              inputMode="numeric"
              size={3}
              value={toteCount}
              onChange={(e) => edit(setToteCount)(e.target.value)}
            />
          </label>
          <label className="intake-toggle">
            <input
              type="checkbox"
              checked={dirtyFish}
              onChange={(e) => edit(setDirtyFish)(e.target.checked)}
            />
            Dirty fish
          </label>
          {dirtyFish && (
            <label>
              Dirty notes
              <input value={dirtyNotes} onChange={(e) => edit(setDirtyNotes)(e.target.value)} />
            </label>
          )}
          <label>
            Cut notes
            <input value={cutNotes} onChange={(e) => edit(setCutNotes)(e.target.value)} />
          </label>
          <label>
            Processing notes
            <input
              value={processingNotes}
              onChange={(e) => edit(setProcessingNotes)(e.target.value)}
            />
          </label>
          <label className="intake-toggle">
            <input
              type="checkbox"
              checked={fastPass}
              onChange={(e) => edit(setFastPass)(e.target.checked)}
            />
            Fast Pass
          </label>
          <label className="intake-toggle">
            <input
              type="checkbox"
              checked={printReceipt}
              onChange={(e) => setPrintReceipt(e.target.checked)}
            />
            Print receipt too
          </label>
        </div>

        {error && (
          <p role="alert" className="station-feedback station-rejected">
            {error}
          </p>
        )}
        <button type="button" className="intake-save" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save & Print Tote Tags"}
        </button>
      </section>
      <PricePanel ctx={ctx} draft={draft} fastPass={fastPass} />
    </div>
  );
}

function PricePanel({
  ctx,
  draft,
  fastPass,
}: {
  ctx: PriceContext | null;
  draft: IntakeDraft | { error: string } | null;
  fastPass: boolean;
}) {
  return (
    <aside className="station-card intake-price" aria-label="Price" aria-live="polite">
      <h2>Price</h2>
      <p className="station-eyebrow">
        {ctx?.rate_card?.name ?? "No rate card"}
        {fastPass && " · Fast Pass"}
        {!fastPass &&
          ctx?.customer?.is_lodge_guest &&
          ctx.customer.lodge_cap !== null &&
          ` · Lodge cap ${money(ctx.customer.lodge_cap)}/lb`}
      </p>
      {!draft ? (
        <p>Add a line to see the price.</p>
      ) : "error" in draft ? (
        <p role="alert">{draft.error}</p>
      ) : (
        <>
          <ul className="intake-yield">
            {draft.lines.map((l, i) => (
              <li key={i}>
                Line {i + 1}: {l.lb} lb → est. {l.estYieldLb ?? "—"} lb
              </li>
            ))}
          </ul>
          <table className="intake-price-lines">
            <tbody>
              {draft.charges.map((c, i) => (
                <tr key={i}>
                  <td>{c.description}</td>
                  <td>{c.qty} lb</td>
                  <td>{money(c.unitPrice)}/lb</td>
                  <td>{money(c.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            {draft.totalLb} lb in · est. yield {draft.totalEstYieldLb} lb
            {draft.ribbing && <span className="station-badge">RIBBING</span>}
          </p>
          <p className="intake-total">Total {money(draft.totalAmount)}</p>
          {draft.missingRates.length > 0 && (
            <p role="alert">No rate for {draft.missingRates.join(", ")}.</p>
          )}
        </>
      )}
    </aside>
  );
}
