"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { BOX_PLAN_METHODS, isHeavy, parse, type BoxPlanMethod } from "rules";
import type { StationSession } from "@/components/intake/use-station-session";
import {
  cancelSession,
  intakeByNumber,
  loadDraft,
  loadReference,
  otherSessions,
  pooledLines,
  priceSession,
  printSettlementReceipt,
  saveSession,
  type Reference,
  type SessionSummary,
} from "./allocate-data";
import {
  BOX_METHOD_LABELS,
  SESSION_STATE_LABELS,
  anglerLb,
  emptyAngler,
  emptyBox,
  emptySpecies,
  money,
  previewSettlements,
  savePayload,
  type AnglerRow,
  type BoxRow,
  type SessionDraft,
  type SpeciesRow,
} from "./allocate-state";

type Lines = Awaited<ReturnType<typeof pooledLines>>;

/**
 * Counter allocation (docs/06-STATIONS-UX.md): pooled intakes → anglers → split method →
 * per-angler species lb → box plans (method, size, weight, heavy check) → Price (settlements
 * computed by price_session) → per-angler receipt with the boxing QR → register.
 */
export function SessionEditor({
  session,
  initial,
  summary: initialSummary,
  onSaved,
}: {
  session: StationSession;
  initial: SessionDraft;
  summary: SessionSummary | null;
  /** Called with the stored session after the first save of a new session. */
  onSaved?: (summary: SessionSummary) => void;
}) {
  const { client } = session;
  const [draft, setDraft] = useState(initial);
  const [summary, setSummary] = useState(initialSummary);
  const [ref, setRef] = useState<Reference | null>(null);
  const [lines, setLines] = useState<Lines>([]);
  const [shared, setShared] = useState<Record<string, string[]>>({});
  const [addIntake, setAddIntake] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [cancelReason, setCancelReason] = useState<string | null>(null);
  // One id per save/price intent: a retry after a lost response replays; any edit starts anew.
  const saveId = useRef<string | null>(null);
  const priceId = useRef<string | null>(null);
  // Set between a committed save and adopting its stored rows (see save()).
  const unadopted = useRef<string | null>(null);

  const state = summary?.state ?? "draft";
  const paid = draft.anglers.some((a) => a.paid);
  const editable = (state === "draft" || state === "priced") && !paid;
  const intakeIds = draft.intakes.map((i) => i.id).join(",");

  useEffect(() => {
    loadReference(client).then(setRef, () => setError("Box sizes and species unavailable."));
  }, [client]);
  useEffect(() => {
    const ids = intakeIds ? intakeIds.split(",") : [];
    pooledLines(client, ids).then(setLines, () => setLines([]));
    otherSessions(client, ids, draft.sessionId).then(setShared, () => setShared({}));
  }, [client, intakeIds, draft.sessionId]);

  const fees = useMemo(
    () => Object.fromEntries((ref?.sizes ?? []).map((s) => [s.id, Number(s.fee)])),
    [ref],
  );
  const sortedIds = (ids: string[]) => [...ids].sort().join(",");
  const pooledChanged =
    !!summary &&
    sortedIds(summary.pool.intakes.map((i) => i.intake_id)) !==
      sortedIds(draft.intakes.map((i) => i.id));
  const preview = summary ? previewSettlements(draft, Number(summary.pool.total), fees) : null;

  function edit(next: SessionDraft) {
    if (unadopted.current) return;
    saveId.current = null;
    priceId.current = null;
    setError("");
    setNotice("");
    setDraft(next);
  }
  const setAngler = (key: string, patch: Partial<AnglerRow>) =>
    edit({ ...draft, anglers: draft.anglers.map((a) => (a.key === key ? { ...a, ...patch } : a)) });
  const setSpecies = (a: AnglerRow, key: string, patch: Partial<SpeciesRow>) =>
    setAngler(a.key, {
      species: a.species.map((s) => (s.key === key ? { ...s, ...patch } : s)),
    });
  const setBox = (a: AnglerRow, key: string, patch: Partial<BoxRow>) =>
    setAngler(a.key, { boxes: a.boxes.map((b) => (b.key === key ? { ...b, ...patch } : b)) });

  async function addByCode() {
    const raw = addIntake.trim();
    if (!raw) return;
    const scanned = parse(raw);
    const number =
      scanned.ok && scanned.value.kind === "TOTE" ? scanned.value.intakeNumber : raw.toUpperCase();
    try {
      const intake = await intakeByNumber(client, number);
      if (!intake) setError(`${number} not found.`);
      else if (draft.intakes.some((i) => i.id === intake.id)) setNotice(`${number} is already in.`);
      else if (["draft", "done", "cancelled"].includes(intake.state))
        setError(`${number} is ${intake.state}; only saved, open intakes can be allocated.`);
      else edit({ ...draft, intakes: [...draft.intakes, intake] });
      setAddIntake("");
    } catch {
      setError("Lookup failed; try again.");
    }
  }

  async function save(thenPrice: boolean) {
    const built = savePayload(draft);
    if ("errors" in built) {
      setError(built.errors.join(" "));
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const isNew = !initial.sessionId;
    let saved: SessionSummary | null = null;
    try {
      // The save commits on its own. Adopt the stored rows (session id, angler and box ids)
      // before pricing, so a pricing failure leaves this editor on the saved session and a
      // retry edits it instead of creating a second one. Until the rows are adopted the action
      // id is kept and edits are blocked: a retry replays the same save and adopts again.
      saveId.current ??= crypto.randomUUID();
      saved = await saveSession(client, saveId.current, built.payload);
      setSummary(saved);
      unadopted.current = saved.number;
      setDraft(await loadDraft(client, saved.session_id));
      unadopted.current = null;
      saveId.current = null;
      let result = saved;
      if (thenPrice) {
        priceId.current ??= crypto.randomUUID();
        result = await priceSession(client, priceId.current, saved.session_id);
        priceId.current = null;
        setSummary(result);
      }
      setNotice(thenPrice ? `${result.number} priced.` : `${result.number} saved.`);
      if (isNew) onSaved?.(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Save failed; try again.";
      setError(
        unadopted.current
          ? `${unadopted.current} was saved, but reloading it failed (${message}). Press Save again.`
          : saved
            ? `${saved.number} saved, but not priced: ${message}`
            : message,
      );
    } finally {
      setBusy(false);
    }
  }

  async function printReceipt(settlementId: string, number: string) {
    try {
      const r = await printSettlementReceipt(client, settlementId);
      setNotice(
        r.printer_missing
          ? `No receipt printer is set up here; open ${number}'s receipt and print it from the browser.`
          : `${number} receipt queued.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Receipt did not queue.");
    }
  }

  async function cancel() {
    if (!draft.sessionId) return;
    setBusy(true);
    try {
      setSummary(await cancelSession(client, draft.sessionId, cancelReason ?? ""));
      setCancelReason(null);
      setNotice("Session cancelled.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed.");
    } finally {
      setBusy(false);
    }
  }

  const speciesName = (code: string) => ref?.species.find((s) => s.code === code)?.name ?? code;
  const methodName = (code: string) => ref?.methods.find((m) => m.code === code)?.name ?? code;
  const lineSpecies = [...new Set(lines.map((l) => l.species_code))];
  const speciesOptions = ref
    ? [
        ...ref.species.filter((s) => lineSpecies.includes(s.code)),
        ...ref.species.filter((s) => !lineSpecies.includes(s.code)),
      ]
    : [];

  return (
    <section className="station-card allocate-editor" aria-label="Allocation session">
      <div className="intake-customer">
        <div>
          <strong>{summary?.number ?? "New session"}</strong>{" "}
          <span className="station-badge">{SESSION_STATE_LABELS[state] ?? state}</span>
          {paid && <span className="station-badge">Has a paid settlement</span>}
        </div>
        <span>Party: {draft.partyName ?? "first intake's customer"}</span>
      </div>

      <h3>Intakes</h3>
      <ul className="station-queue intake-list" aria-label="Pooled intakes">
        {draft.intakes.map((i) => {
          const pool = summary?.pool.intakes.find((p) => p.intake_id === i.id);
          return (
            <li key={i.id}>
              <span>{i.number}</span>
              <span>{i.customer}</span>
              <span className="station-badge">{i.state}</span>
              {pool && <span>{money(Number(pool.amount))} processing</span>}
              {pool && !pool.billed_here && pool.billed_by && (
                <span className="station-badge">Billed by {pool.billed_by}</span>
              )}
              {(shared[i.id] ?? []).length > 0 && (
                <span className="station-badge">Also in {shared[i.id]!.join(", ")}</span>
              )}
              {editable && draft.intakes.length > 1 && (
                <button
                  type="button"
                  onClick={() =>
                    edit({ ...draft, intakes: draft.intakes.filter((x) => x.id !== i.id) })
                  }
                >
                  Remove
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {editable && (
        <div className="intake-fields">
          <label>
            Add intake (number or scan a tote tag)
            <input
              value={addIntake}
              onChange={(e) => setAddIntake(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void addByCode();
                }
              }}
              placeholder="INT-0042"
            />
          </label>
          <button type="button" onClick={() => void addByCode()}>
            Add
          </button>
        </div>
      )}
      {lines.length > 0 && (
        <p className="station-hint">
          Brought in:{" "}
          {lines
            .map(
              (l) =>
                `${speciesName(l.species_code)} ${methodName(l.method_code)} ${l.lb} lb` +
                (l.est_yield_lb ? ` (≈${l.est_yield_lb} lb yield)` : ""),
            )
            .join(" · ")}
        </p>
      )}

      <h3>Split</h3>
      <div className="intake-fields" role="radiogroup" aria-label="Split method">
        {(
          [
            ["weight", "By weight (∝ take-home lb)"],
            ["even", "Even"],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="intake-toggle">
            <input
              type="radio"
              name="split"
              checked={draft.splitMethod === value}
              disabled={!editable}
              onChange={() => edit({ ...draft, splitMethod: value })}
            />
            {label}
          </label>
        ))}
        <label>
          Notes
          <input
            value={draft.notes}
            disabled={!editable}
            onChange={(e) => edit({ ...draft, notes: e.target.value })}
          />
        </label>
      </div>

      <h3>Anglers</h3>
      {draft.anglers.map((a, ai) => (
        <fieldset key={a.key} className="allocate-angler" disabled={!editable}>
          <legend>
            {a.number ?? `Angler ${ai + 1}`} · {anglerLb(a)} lb
          </legend>
          <div className="intake-fields">
            <label>
              Name
              <input
                aria-label={`Angler ${ai + 1} name`}
                value={a.angler_name}
                onChange={(e) => setAngler(a.key, { angler_name: e.target.value })}
              />
            </label>
            <label>
              Retail note
              <input
                value={a.retail_note}
                onChange={(e) => setAngler(a.key, { retail_note: e.target.value })}
              />
            </label>
            {draft.anglers.length > 1 && (
              <button
                type="button"
                onClick={() =>
                  edit({ ...draft, anglers: draft.anglers.filter((x) => x.key !== a.key) })
                }
              >
                Remove angler
              </button>
            )}
          </div>
          <table className="intake-lines">
            <thead>
              <tr>
                <th>Species</th>
                <th>Method</th>
                <th>Take-home lb</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {a.species.map((s) => (
                <tr key={s.key}>
                  <td>
                    <select
                      aria-label="Species"
                      value={s.species_code}
                      onChange={(e) => setSpecies(a, s.key, { species_code: e.target.value })}
                    >
                      <option value="">Species…</option>
                      {speciesOptions.map((o) => (
                        <option key={o.code} value={o.code}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      aria-label="Method"
                      value={s.method_code}
                      onChange={(e) => setSpecies(a, s.key, { method_code: e.target.value })}
                    >
                      <option value="">Method…</option>
                      {(ref?.methods ?? []).map((o) => (
                        <option key={o.code} value={o.code}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      aria-label="Take-home lb"
                      inputMode="decimal"
                      value={s.lb}
                      onChange={(e) => setSpecies(a, s.key, { lb: e.target.value })}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={() =>
                        setAngler(a.key, { species: a.species.filter((x) => x.key !== s.key) })
                      }
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            type="button"
            onClick={() => setAngler(a.key, { species: [...a.species, emptySpecies()] })}
          >
            Add species
          </button>

          <table className="intake-lines" aria-label={`Boxes for angler ${ai + 1}`}>
            <thead>
              <tr>
                <th>Box</th>
                <th>Method</th>
                <th>Size</th>
                <th>Weight lb</th>
                <th>Heavy</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {a.boxes.map((b) => {
                const locked = b.fulfillment_state !== "planned";
                const weight = Number(b.weight);
                return (
                  <tr key={b.key}>
                    <td>
                      {b.number ?? "new"}
                      {locked && <span className="station-badge">{b.fulfillment_state}</span>}
                    </td>
                    <td>
                      <select
                        aria-label="Box method"
                        value={b.method}
                        disabled={locked}
                        onChange={(e) =>
                          setBox(a, b.key, { method: e.target.value as BoxPlanMethod })
                        }
                      >
                        {BOX_PLAN_METHODS.map((m) => (
                          <option key={m} value={m}>
                            {BOX_METHOD_LABELS[m]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        aria-label="Box size"
                        value={b.box_size_id}
                        disabled={locked}
                        onChange={(e) => setBox(a, b.key, { box_size_id: e.target.value })}
                      >
                        <option value="">Size…</option>
                        {(ref?.sizes ?? [])
                          .filter((z) => z.is_active || z.id === b.box_size_id)
                          .map((z) => (
                            <option key={z.id} value={z.id}>
                              {z.name} (≤{z.max_lb} lb, {money(Number(z.fee))})
                            </option>
                          ))}
                      </select>
                    </td>
                    <td>
                      <input
                        aria-label="Box weight lb"
                        inputMode="decimal"
                        value={b.weight}
                        disabled={locked}
                        onChange={(e) => setBox(a, b.key, { weight: e.target.value })}
                      />
                    </td>
                    <td>
                      {Number.isFinite(weight) && isHeavy(weight) ? (
                        <label className="intake-toggle">
                          <input
                            type="checkbox"
                            checked={b.heavy_allowed}
                            disabled={locked}
                            onChange={(e) => setBox(a, b.key, { heavy_allowed: e.target.checked })}
                          />
                          Heavy OK (over 70 lb)
                        </label>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      {!locked && (
                        <button
                          type="button"
                          onClick={() =>
                            setAngler(a.key, { boxes: a.boxes.filter((x) => x.key !== b.key) })
                          }
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button
            type="button"
            onClick={() =>
              setAngler(a.key, {
                boxes: [...a.boxes, emptyBox(ref?.sizes.find((z) => z.is_active)?.id ?? "")],
              })
            }
          >
            Add box
          </button>
        </fieldset>
      ))}
      {editable && (
        <button
          type="button"
          onClick={() => edit({ ...draft, anglers: [...draft.anglers, emptyAngler()] })}
        >
          Add angler
        </button>
      )}

      <h3>Price</h3>
      {!summary ? (
        <p className="station-hint">Save the session to see the pooled processing charges.</p>
      ) : (
        <>
          <p>
            Pooled processing {money(Number(summary.pool.total))}
            {pooledChanged && " — intakes changed; save to refresh"}
          </p>
          {preview && "reason" in preview ? (
            <p className="station-hint">{preview.reason}</p>
          ) : preview ? (
            <table className="intake-price-lines" aria-label="Price preview">
              <thead>
                <tr>
                  <th>Angler</th>
                  <th>lb</th>
                  <th>Processing</th>
                  <th>Boxes</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {preview.settlements.map((p, i) => (
                  <tr key={draft.anglers[i]!.key}>
                    <td>{draft.anglers[i]!.angler_name || `Angler ${i + 1}`}</td>
                    <td>{p.weightTotalLb}</td>
                    <td>{money(p.processingShare)}</td>
                    <td>{money(p.boxFeeTotal)}</td>
                    <td>{money(p.amountTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </>
      )}

      {error && (
        <p role="alert" className="station-feedback station-rejected">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="station-feedback station-ok">
          {notice}
        </p>
      )}

      {editable && (
        <div className="station-actions">
          <button type="button" disabled={busy} onClick={() => void save(false)}>
            Save
          </button>
          <button
            type="button"
            className="intake-save"
            disabled={busy}
            onClick={() => void save(true)}
          >
            {state === "priced" ? "Save & Reprice" : "Save & Price"}
          </button>
        </div>
      )}

      {summary && (state === "priced" || state === "done") && (
        <>
          <h3>Settlements</h3>
          <table className="intake-price-lines" aria-label="Settlements">
            <thead>
              <tr>
                <th>Settlement</th>
                <th>Angler</th>
                <th>lb</th>
                <th>Processing</th>
                <th>Boxes</th>
                <th>Freight</th>
                <th>Total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {summary.settlements.map((s) => (
                <tr key={s.settlement_id}>
                  <td>
                    {s.number} {s.state === "paid" && <span className="station-badge">Paid</span>}
                  </td>
                  <td>{s.angler_name}</td>
                  <td>{s.weight_total_lb}</td>
                  <td>{money(Number(s.processing_share))}</td>
                  <td>{money(Number(s.box_fee_total))}</td>
                  <td>{money(Number(s.freight_total))}</td>
                  <td>{money(Number(s.amount_total))}</td>
                  <td className="station-actions">
                    <Link href={`/allocate/receipt/${s.settlement_id}`}>Receipt</Link>
                    <button
                      type="button"
                      onClick={() => void printReceipt(s.settlement_id, s.number)}
                    >
                      Print
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="station-hint">
            Hand off to the register: each angler pays their settlement there.
          </p>
        </>
      )}

      {editable && draft.sessionId && (
        <div className="intake-fields">
          {cancelReason === null ? (
            <button type="button" onClick={() => setCancelReason("")}>
              Cancel session…
            </button>
          ) : (
            <>
              <label>
                Reason
                <input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
              </label>
              <button type="button" disabled={busy} onClick={() => void cancel()}>
                Confirm cancel
              </button>
              <button type="button" onClick={() => setCancelReason(null)}>
                Keep session
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
