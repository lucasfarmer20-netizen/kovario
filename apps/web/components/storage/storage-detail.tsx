"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { encode, formatPhone } from "rules";
import { ManagerPinOverlay } from "@/src/components/station/pin-overlay";
import { money } from "@/components/intake/intake-form-state";
import { managerElevation, type StationSession } from "@/components/intake/use-station-session";
import {
  cancelPickupBatch,
  createPickupBatch,
  forceRelease,
  loadLabelData,
  loadStorageIntake,
  pickupReceipt,
  printLabels,
  quotePickup,
  type LabelsQueued,
  type LoadedStorageIntake,
  type PickupReceipt,
  type Quote,
} from "./storage-data";
import {
  BATCH_STATE_LABELS,
  STORAGE_STATE_LABELS,
  boxRollup,
  daysLabel,
  toggleBox,
} from "./storage-state";

type Batch = LoadedStorageIntake["batches"][number];
type Release = { batch: Batch; mode: "manual" | "comp"; reason: string };

/**
 * A storage intake: boxes with their days stored (the storage_box_days view), the pickup
 * wizard (select boxes → quote → pending batch for the register), and the batches with
 * Cancel, receipt, and manager Force Release / COMP (reason + manager PIN).
 */
export function StorageDetail({
  session,
  storageIntakeId,
  notice,
}: {
  session: StationSession;
  storageIntakeId: string;
  notice?: string;
}) {
  const { client } = session;
  const [data, setData] = useState<LoadedStorageIntake | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  // The quote for the selection it priced; a stale one (selection changed) is not shown.
  const [priced, setPriced] = useState<{ key: string; quote: Quote } | null>(null);
  const [receipt, setReceipt] = useState<PickupReceipt | null>(null);
  const [release, setRelease] = useState<Release | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [message, setMessage] = useState(notice ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  // One id per "create batch" intent; changing the selection starts a new one.
  const batchActionId = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    loadStorageIntake(client, storageIntakeId).then(
      (loaded) => live && setData(loaded),
      () => live && setError("Storage intake unavailable; reload."),
    );
    return () => {
      live = false;
    };
  }, [client, storageIntakeId, version]);

  useEffect(() => {
    let live = true;
    if (selected.length === 0) return;
    const key = selected.join();
    quotePickup(client, storageIntakeId, selected).then(
      (quote) => live && setPriced({ key, quote }),
      (err: unknown) => live && setError(err instanceof Error ? err.message : "Quote failed."),
    );
    return () => {
      live = false;
    };
  }, [client, storageIntakeId, selected, version]);

  async function run<T>(label: string, fn: () => Promise<T>, done: (r: T) => string) {
    setBusy(true);
    setError("");
    try {
      const r = await fn();
      setMessage(done(r));
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed.`);
    } finally {
      setBusy(false);
    }
  }

  const printed = (r: LabelsQueued) =>
    r.printer_missing
      ? "Labels: no label printer is set up for this site."
      : `Labels: ${r.label_jobs_queued} queued.`;

  if (!data) return <p>{error || "Loading storage intake…"}</p>;
  const { intake, boxes, batches } = data;
  if (!intake) return <p role="alert">Storage intake not found.</p>;
  const boxLabel = new Map(boxes.map((b) => [b.storage_box_id, b.label]));
  const quote = priced?.key === selected.join() ? priced.quote : null;

  return (
    <>
      <section className="station-card intake-header" aria-label="Storage intake header">
        <div>
          <p className="intake-number">{intake.number}</p>
          <p>
            <strong>{intake.customer?.name}</strong>
            {intake.customer?.phone && ` · ${formatPhone(intake.customer.phone)}`}
          </p>
          <div className="station-chips">
            <span className="station-badge">
              {STORAGE_STATE_LABELS[intake.state] ?? intake.state}
            </span>
            <span className="station-badge">
              {boxRollup(intake.active_box_count, intake.box_count)}
            </span>
            {intake.location && <span className="station-badge">{intake.location.code}</span>}
            {intake.paid_at && <span className="station-badge">Paid · {intake.payment_ref}</span>}
          </div>
          {intake.notes && <p>{intake.notes}</p>}
        </div>
        <div className="station-actions">
          <button
            disabled={busy}
            onClick={() =>
              void run(
                "Labels",
                async () => printLabels(client, await loadLabelData(client, intake.id)),
                printed,
              )
            }
          >
            Reprint Labels
          </button>
          <button
            disabled={busy}
            // Receipts print from the browser: the agent prints PDFs only from an HTTPS URL
            // and there is no PDF render/upload pipeline yet.
            onClick={() => window.print()}
          >
            Print Receipt
          </button>
          <Link href="/storage">New Storage</Link>
        </div>
      </section>
      {message && <p className="station-feedback station-ok">{message}</p>}
      {error && (
        <p className="station-feedback station-rejected" role="alert">
          {error}
        </p>
      )}

      <div className="station-workspace">
        <section className="station-card" aria-label="Boxes">
          <h2>Boxes</h2>
          <table className="intake-lines">
            <thead>
              <tr>
                <th>Pick up</th>
                <th>Box</th>
                <th>Weight</th>
                <th>Description</th>
                <th>Days stored</th>
                <th>Label QR</th>
              </tr>
            </thead>
            <tbody>
              {boxes.map((b) => {
                const id = b.storage_box_id ?? "";
                const stored = b.state === "stored";
                return (
                  <tr key={id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Pick up ${b.label}`}
                        disabled={!stored || busy}
                        checked={selected.includes(id)}
                        onChange={() => {
                          batchActionId.current = null;
                          setSelected(toggleBox(selected, id, stored));
                        }}
                      />
                    </td>
                    <td>
                      {b.label}
                      {!stored && " · picked up"}
                    </td>
                    <td>{b.weight_lb === null ? "—" : `${b.weight_lb} lb`}</td>
                    <td>{b.description}</td>
                    <td>{b.days_stored === null ? "—" : daysLabel(b.days_stored)}</td>
                    <td>
                      <code>
                        {encode("SBOX", { storageNumber: intake.number, boxNo: b.box_no ?? 0 })}
                      </code>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <h2>Pickup</h2>
          {selected.length === 0 ? (
            <p className="station-hint">Tick the boxes going home today.</p>
          ) : quote ? (
            <>
              <table className="intake-price-lines">
                <tbody>
                  {quote.boxes.map((l) => (
                    <tr key={l.box_id}>
                      <td>{l.label}</td>
                      <td>{daysLabel(l.days)}</td>
                      <td>{money(quote.rate)}/box-day</td>
                      <td>{money(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="intake-total">
                {quote.box_days} box-days · Total {money(quote.amount)}
              </p>
              <div className="station-actions">
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(
                      "Pickup batch",
                      async () => {
                        batchActionId.current ??= crypto.randomUUID();
                        const r = await createPickupBatch(
                          client,
                          batchActionId.current,
                          intake.id,
                          selected,
                        );
                        batchActionId.current = null;
                        setSelected([]);
                        return r;
                      },
                      (r) =>
                        `${r.number} for ${money(r.amount)} is ready to charge at the register` +
                        (r.superseded.length > 0 ? ` (replaces ${r.superseded.join(", ")}).` : "."),
                    )
                  }
                >
                  Create Pickup Batch
                </button>
              </div>
            </>
          ) : (
            <p>Pricing…</p>
          )}
        </section>

        <section className="station-card" aria-label="Pickup batches">
          <h2>Pickup batches</h2>
          {batches.length === 0 && <p>No pickups yet.</p>}
          <ul className="station-queue">
            {batches.map((b) => (
              <li key={b.id}>
                <strong>{b.number}</strong>
                <span className="station-badge">{BATCH_STATE_LABELS[b.state] ?? b.state}</span>
                {b.release_failed && <span className="station-badge">RELEASE FAILED</span>}
                <span>
                  {b.box_ids.map((id) => boxLabel.get(id) ?? "?").join(", ")} · {money(b.amount)}
                </span>
                {b.payment_ref && <span>Ref {b.payment_ref}</span>}
                <div className="station-actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void pickupReceipt(client, b.id).then(setReceipt, () =>
                        setError("Receipt unavailable."),
                      )
                    }
                  >
                    Receipt
                  </button>
                  {b.state === "pending" && !b.release_failed && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(
                          "Cancel",
                          () => cancelPickupBatch(client, b.id),
                          () => `${b.number} cancelled.`,
                        )
                      }
                    >
                      Cancel
                    </button>
                  )}
                  {b.state !== "released" && (
                    <>
                      <button
                        disabled={busy}
                        onClick={() => setRelease({ batch: b, mode: "manual", reason: "" })}
                      >
                        Force Release
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => setRelease({ batch: b, mode: "comp", reason: "" })}
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

          {release && (
            <form
              className="station-card"
              aria-label={release.mode === "comp" ? "COMP batch" : "Force Release batch"}
              onSubmit={(e) => {
                e.preventDefault();
                if (!release.reason.trim()) {
                  setError("Enter a reason.");
                  return;
                }
                setPinOpen(true);
              }}
            >
              <h3>
                {release.mode === "comp"
                  ? `COMP ${release.batch.number} — waive ${money(release.batch.amount)}`
                  : `Force Release ${release.batch.number}`}
              </h3>
              <label>
                Reason{" "}
                <input
                  autoFocus
                  value={release.reason}
                  onChange={(e) => setRelease({ ...release, reason: e.target.value })}
                />
              </label>
              <div className="station-actions">
                <button type="submit">Manager PIN…</button>
                <button type="button" onClick={() => setRelease(null)}>
                  Back
                </button>
              </div>
            </form>
          )}

          {receipt && (
            <section
              className="station-card storage-receipt"
              aria-label={`Receipt ${receipt.number}`}
            >
              <h3>
                Receipt {receipt.number} · {receipt.storage_number} · {receipt.date}
              </h3>
              <table className="intake-price-lines">
                <tbody>
                  {receipt.lines.map((l) => (
                    <tr key={l.box_id}>
                      <td>{l.label}</td>
                      <td>{daysLabel(l.days)}</td>
                      <td>{money(l.rate)}/box-day</td>
                      <td>{money(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="intake-total">
                Total {money(receipt.total)}
                {receipt.payment_ref && ` · ${receipt.payment_ref}`}
              </p>
              <div className="station-actions">
                <button type="button" onClick={() => window.print()}>
                  Print
                </button>
                <button type="button" onClick={() => setReceipt(null)}>
                  Close
                </button>
              </div>
            </section>
          )}
        </section>
      </div>

      {pinOpen && release && (
        <ManagerPinOverlay
          onClose={() => setPinOpen(false)}
          verify={async (pin) => {
            const elevation = await managerElevation(client, pin);
            if ("reason" in elevation) return { ok: false, reason: elevation.reason };
            try {
              const r = await forceRelease(
                client,
                release.batch.id,
                release.mode,
                release.reason.trim(),
                elevation.token,
              );
              setMessage(`${release.batch.number} released (${r.payment_ref}).`);
            } catch (err) {
              return { ok: false, reason: err instanceof Error ? err.message : "Release failed" };
            }
            setRelease(null);
            refresh();
            return { ok: true };
          }}
        />
      )}
    </>
  );
}
