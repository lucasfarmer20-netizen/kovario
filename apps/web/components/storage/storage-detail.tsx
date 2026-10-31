"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { encode, formatPhone } from "rules";
import { ManagerPinOverlay } from "@/src/components/station/pin-overlay";
import { ManualEntry, useManualOptions } from "@/src/components/station/manual-entry";
import { KeyboardStatus, type KeyboardFeedback } from "@/src/components/station/keyboard-status";
import { money } from "@/components/intake/intake-form-state";
import { refusal, type Prompt } from "@/components/intake/intake-view";
import {
  managerElevation,
  sessionLabel,
  type StationSession,
} from "@/components/intake/use-station-session";
import {
  cancelPickupBatch,
  createPickupBatch,
  forceRelease,
  loadLabelData,
  loadStorageIntake,
  pickupReceipt,
  printLabels,
  quotePickup,
  scanStorageBox,
  type LabelsQueued,
  type LoadedStorageIntake,
  type PickupReceipt,
  type Quote,
} from "./storage-data";
import { BATCH_STATE_LABELS, STORAGE_STATE_LABELS, boxRollup, toggleBox } from "./storage-state";
import {
  PICKUP_STEPS,
  StorageDetailSkeleton,
  StorageDetailView,
  StorageShell,
  pickupNextStep,
  type StorageBatch,
  type StorageBox,
  type StorageOrder,
} from "./storage-view";

type Batch = LoadedStorageIntake["batches"][number];
type Release = { batch: Batch; mode: "manual" | "comp"; reason: string };

/** The loaded rows as the pickup screen shows them. */
export function storageOrder(data: LoadedStorageIntake): {
  order: StorageOrder;
  boxes: StorageBox[];
  batches: StorageBatch[];
} | null {
  const { intake, boxes, batches } = data;
  if (!intake) return null;
  const boxLabel = new Map(boxes.map((b) => [b.storage_box_id, b.label]));
  return {
    order: {
      number: intake.number,
      customer: intake.customer?.name ?? null,
      phone: intake.customer?.phone ? formatPhone(intake.customer.phone) : null,
      chips: [
        STORAGE_STATE_LABELS[intake.state] ?? intake.state,
        boxRollup(intake.active_box_count, intake.box_count),
        ...(intake.location ? [intake.location.code] : []),
        ...(intake.paid_at ? [`Paid · ${intake.payment_ref}`] : []),
      ],
      notes: intake.notes,
    },
    boxes: boxes.map((b) => ({
      id: b.storage_box_id ?? "",
      label: b.label ?? "",
      stored: b.state === "stored",
      weight: b.weight_lb,
      description: b.description,
      days: b.days_stored,
      qr: encode("SBOX", { storageNumber: intake.number, boxNo: b.box_no ?? 0 }),
    })),
    batches: batches.map((b) => ({
      id: b.id,
      number: b.number,
      code: b.state,
      state: BATCH_STATE_LABELS[b.state] ?? b.state,
      releaseFailed: b.release_failed,
      boxes: b.box_ids.map((id) => boxLabel.get(id) ?? "?").join(", "),
      amount: b.amount,
      paymentRef: b.payment_ref,
      notes: b.notes,
    })),
  };
}

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
  const [feedback, setFeedback] = useState<KeyboardFeedback | null>(
    notice ? { ok: true, text: notice, event: 0 } : null,
  );
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const manual = useManualOptions(client, session.claims.orgId);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  // One id per "create batch" intent; changing the selection starts a new one.
  const batchActionId = useRef<string | null>(null);
  const say = (ok: boolean, text: string) => setFeedback({ ok, text, event: Date.now() });

  useEffect(() => {
    let live = true;
    loadStorageIntake(client, storageIntakeId).then(
      (loaded) => {
        if (!live) return;
        setData(loaded);
        setLoadError("");
      },
      () => live && setLoadError("Storage order unavailable. Check the connection and reload."),
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
      (err: unknown) =>
        live &&
        say(
          false,
          refusal(err instanceof Error ? err.message : "Quote failed", "Tick the boxes again."),
        ),
    );
    return () => {
      live = false;
    };
  }, [client, storageIntakeId, selected, version]);

  async function run<T>(label: string, fn: () => Promise<T>, done: (r: T) => string) {
    setBusy(true);
    try {
      const r = await fn();
      say(true, done(r));
      refresh();
    } catch (err) {
      say(false, refusal(err instanceof Error ? err.message : `${label} failed`, "Tap it again."));
    } finally {
      setBusy(false);
    }
  }

  const printed = (r: LabelsQueued) =>
    r.printer_missing
      ? "Labels: no label printer is set up for this site."
      : `Labels: ${r.label_jobs_queued} queued.`;

  const mapped = data ? storageOrder(data) : null;
  const pending = mapped?.batches.some((b) => b.code === "pending") ?? false;
  const prompt: Prompt = !data
    ? { next: "Opening the storage order", step: 0 }
    : !mapped
      ? { next: "Tap New Storage to start one", step: 0, tone: "warn" }
      : release
        ? { next: "Enter the reason, then a manager PIN", step: 2, tone: "warn" }
        : pickupNextStep(selected.length, pending);
  const shell = (body: ReactNode) => (
    <StorageShell
      site={session.siteName}
      operator={sessionLabel(session)}
      prompt={prompt}
      steps={PICKUP_STEPS}
      status={
        <KeyboardStatus
          feedback={feedback}
          notice={loadError ? { tone: "error", text: loadError } : null}
        />
      }
    >
      {body}
    </StorageShell>
  );

  if (!data) return shell(<StorageDetailSkeleton />);
  if (!mapped || !data.intake)
    return shell(
      <section className="station-card st-hero-empty" aria-label="Storage order">
        <h2>Storage order not found</h2>
        <p>It may have been cancelled. Open one from the Storage Queue.</p>
      </section>,
    );
  const intake = data.intake;
  const quote = priced?.key === selected.join() ? priced.quote : null;

  return shell(
    <>
      <StorageDetailView
        order={mapped.order}
        boxes={mapped.boxes}
        selected={selected}
        quote={quote}
        batches={mapped.batches}
        release={
          release
            ? {
                number: release.batch.number,
                amount: release.batch.amount,
                mode: release.mode,
                reason: release.reason,
              }
            : null
        }
        receipt={receipt}
        busy={busy || pinOpen}
        manual={
          // Freezer pickups: a box code typed here is checked against the storage master and
          // logged in scan_log (issue #84); an accepted box joins the selection.
          <ManualEntry
            open={typing}
            onOpenChange={setTyping}
            disabled={busy}
            options={{ ...manual, accept: ["SBOX"] }}
            label="Box (STG-0001-2)"
            onSubmit={(text, parsed) => {
              void scanStorageBox(client, intake.id, text, parsed, "manual").then(
                (reply) => {
                  const boxId = reply.box_id;
                  if (reply.ok && boxId) {
                    batchActionId.current = null;
                    setSelected((ids) => (ids.includes(boxId) ? ids : [...ids, boxId]));
                  }
                  say(reply.ok, reply.reason);
                },
                () => say(false, "Code not recorded; check the connection and enter it again."),
              );
            }}
          />
        }
        on={{
          toggle: (id, stored) => {
            batchActionId.current = null;
            setSelected(toggleBox(selected, id, stored));
          },
          createBatch: () =>
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
            ),
          reprintLabels: () =>
            void run(
              "Labels",
              async () => printLabels(client, await loadLabelData(client, intake.id)),
              printed,
            ),
          // Receipts print from the browser: the agent prints PDFs only from an HTTPS URL and
          // there is no PDF render/upload pipeline yet.
          printReceipt: () => window.print(),
          receipt: (id) =>
            void pickupReceipt(client, id).then(setReceipt, () =>
              say(false, "Receipt unavailable. Check the connection and tap Receipt again."),
            ),
          closeReceipt: () => setReceipt(null),
          cancelBatch: (id) => {
            const b = data.batches.find((x) => x.id === id);
            void run(
              "Cancel",
              () => cancelPickupBatch(client, id),
              () => `${b?.number} cancelled.`,
            );
          },
          startRelease: (id, mode) => {
            const b = data.batches.find((x) => x.id === id);
            if (b) setRelease({ batch: b, mode, reason: "" });
          },
          releaseReason: (reason) => setRelease((r) => (r ? { ...r, reason } : r)),
          confirmRelease: () => {
            if (!release?.reason.trim()) return;
            setPinOpen(true);
          },
          cancelRelease: () => setRelease(null),
        }}
      />
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
              say(true, `${release.batch.number} released (${r.payment_ref}).`);
            } catch (err) {
              return { ok: false, reason: err instanceof Error ? err.message : "Release failed" };
            }
            setRelease(null);
            refresh();
            return { ok: true };
          }}
        />
      )}
    </>,
  );
}
