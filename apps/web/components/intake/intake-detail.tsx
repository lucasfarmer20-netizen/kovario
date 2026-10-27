"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  CONDITIONS,
  METHODS,
  SPECIES,
  formatPhone,
  isConditionCode,
  isMethodCode,
  isSpeciesCode,
} from "rules";
import { ManagerPinOverlay } from "@/src/components/station/pin-overlay";
import { IntakeForm } from "./intake-form";
import {
  loadCustomer,
  loadIntake,
  printReceipt,
  reprintToteTags,
  unlockIntake,
  type LoadedIntake,
} from "./intake-data";
import { STATE_LABELS, coolerBadge, intakeTimeline, lineToRow, money } from "./intake-form-state";
import { managerElevation, type StationSession } from "./use-station-session";
import type { CustomerHit } from "@/components/customers/customer-search-state";

const name = {
  species: (c: string) => (isSpeciesCode(c) ? SPECIES[c].name : c),
  condition: (c: string) => (isConditionCode(c) ? CONDITIONS[c].name : c),
  method: (c: string) => (isMethodCode(c) ? METHODS[c].name : c),
};

/**
 * A saved intake: read-only while locked, with the post-save header (Reprint, Print Receipt,
 * New Intake, manager Unlock), lines, charges with their per-lb rates, tote tags and the
 * timeline of timestamps. Unlocking switches to the edit form; saving locks it again.
 */
export function IntakeDetail({
  session,
  intakeId,
  notice,
}: {
  session: StationSession;
  intakeId: string;
  notice?: string;
}) {
  const { client } = session;
  const [data, setData] = useState<LoadedIntake | null>(null);
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [message, setMessage] = useState(notice ?? "");
  const [error, setError] = useState("");
  const [pinOpen, setPinOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    let live = true;
    loadIntake(client, intakeId)
      .then(async (loaded) => {
        const hit = loaded.intake ? await loadCustomer(client, loaded.intake.customer_id) : null;
        if (!live) return;
        setData(loaded);
        setCustomer(hit);
        setNow(new Date());
      })
      .catch(() => live && setError("Intake unavailable; reload."));
    return () => {
      live = false;
    };
  }, [client, intakeId, version]);

  async function run(label: string, fn: () => Promise<{ printer_missing: boolean }>) {
    setBusy(true);
    setError("");
    try {
      const r = await fn();
      setMessage(
        r.printer_missing ? `${label}: no printer is set up for this site.` : `${label}: queued.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed.`);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <p>{error || "Loading intake…"}</p>;
  const { intake, lines, charges, totes } = data;
  if (!intake) return <p role="alert">Intake not found.</p>;

  if (!intake.locked && customer && (intake.state === "draft" || intake.state === "holding")) {
    return (
      <>
        <p className="station-feedback">Unlocked — edit and save to lock {intake.number} again.</p>
        <IntakeForm
          session={session}
          initial={{
            intakeId: intake.id,
            customer,
            rows: lines.map(lineToRow),
            toteCount: intake.tote_count,
            dirtyFish: intake.dirty_fish,
            dirtyNotes: intake.dirty_notes ?? "",
            cutNotes: intake.cut_notes ?? "",
            processingNotes: intake.processing_notes ?? "",
            fastPass: intake.fast_pass,
          }}
          onSaved={(r) => {
            setMessage(
              r.printer_missing
                ? `${r.number} saved. No tote printer is set up for this site.`
                : `${r.number} saved; ${r.tote_jobs_queued} tote tags queued.`,
            );
            refresh();
          }}
        />
      </>
    );
  }

  const total = charges.reduce((s, c) => s + (c.amount ?? 0), 0);
  const badge = coolerBadge(intake.state, intake.intake_at, now);
  return (
    <>
      <section className="station-card intake-header" aria-label="Intake header">
        <div>
          <p className="intake-number">{intake.number}</p>
          <p>
            <strong>{intake.customer?.name}</strong>
            {intake.customer?.phone && ` · ${formatPhone(intake.customer.phone)}`}
          </p>
          <div className="station-chips">
            <span className="station-badge">{STATE_LABELS[intake.state] ?? intake.state}</span>
            {badge && <span className="station-badge">{badge}</span>}
            {intake.locked && <span className="station-badge">Locked</span>}
            {intake.fast_pass && <span className="station-badge">FAST PASS</span>}
            {intake.dirty_fish && <span className="station-badge">DIRTY</span>}
            {intake.ribbing && <span className="station-badge">RIBBING</span>}
            {intake.is_lodge_guest && <span className="station-badge">Lodge</span>}
          </div>
        </div>
        <div className="station-actions">
          <button
            disabled={busy}
            onClick={() => void run("Tote tags", () => reprintToteTags(client, intake.id))}
          >
            Reprint
          </button>
          <button
            disabled={busy}
            onClick={() => void run("Receipt", () => printReceipt(client, intake.id))}
          >
            Print Receipt
          </button>
          <Link href="/intake">New Intake</Link>
          {intake.locked && (intake.state === "draft" || intake.state === "holding") && (
            <button disabled={busy} onClick={() => setPinOpen(true)}>
              Unlock
            </button>
          )}
        </div>
      </section>
      {message && <p className="station-feedback station-ok">{message}</p>}
      {error && (
        <p className="station-feedback station-rejected" role="alert">
          {error}
        </p>
      )}

      <div className="station-workspace">
        <section className="station-card">
          <h2>Lines</h2>
          <table className="intake-lines">
            <thead>
              <tr>
                <th>Species</th>
                <th>Condition</th>
                <th>Method</th>
                <th>lb</th>
                <th>Est. yield</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td>{name.species(l.species_code)}</td>
                  <td>{name.condition(l.condition_code)}</td>
                  <td>
                    {name.method(l.method_code)}
                    {l.fillets_pct !== null && ` ${l.fillets_pct}/${100 - l.fillets_pct}`}
                    {l.skin_off && " · skin off"}
                  </td>
                  <td>{l.lb}</td>
                  <td>{l.est_yield_lb ?? "—"}</td>
                  <td>{l.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            {intake.total_incoming_lb} lb in · est. yield {intake.total_est_yield_lb} lb ·{" "}
            {intake.tote_count} totes
          </p>
          {intake.dirty_notes && <p>Dirty: {intake.dirty_notes}</p>}
          {intake.cut_notes && <p>Cut: {intake.cut_notes}</p>}
          {intake.processing_notes && <p>Processing: {intake.processing_notes}</p>}

          <h2>Charges</h2>
          <table className="intake-price-lines">
            <tbody>
              {charges.map((c) => (
                <tr key={c.id}>
                  <td>{c.description}</td>
                  <td>{c.qty} lb</td>
                  <td>{money(c.unit_price)}/lb</td>
                  <td>{money(c.amount)}</td>
                  <td>{c.state === "open" ? "" : c.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="intake-total">Total {money(total)}</p>
        </section>
        <section className="station-card">
          <h2>Timeline</h2>
          <ol className="intake-timeline">
            {intakeTimeline(intake).map((e) => (
              <li key={e.label}>
                <span>{e.label}</span>{" "}
                <time dateTime={e.at}>{new Date(e.at).toLocaleString()}</time>
              </li>
            ))}
          </ol>
          <h2>Tote tags</h2>
          <ul>
            {totes.map((t) => (
              <li key={t.tote_no}>
                Tote {t.tote_no} of {t.of_count} · <code>{t.qr}</code>
                {t.print_job_id ? "" : " · not queued"}
              </li>
            ))}
          </ul>
        </section>
      </div>

      {pinOpen && (
        <ManagerPinOverlay
          onClose={() => setPinOpen(false)}
          verify={async (pin) => {
            const elevation = await managerElevation(client, pin);
            if ("reason" in elevation) return { ok: false, reason: elevation.reason };
            try {
              await unlockIntake(client, intake.id, elevation.token);
            } catch (err) {
              return { ok: false, reason: err instanceof Error ? err.message : "Unlock failed" };
            }
            setMessage(`${intake.number} unlocked.`);
            refresh();
            return { ok: true };
          }}
        />
      )}
    </>
  );
}
