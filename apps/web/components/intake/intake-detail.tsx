"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { CONDITIONS, METHODS, SPECIES, isConditionCode, isMethodCode, isSpeciesCode } from "rules";
import { ManagerPinOverlay } from "@/src/components/station/pin-overlay";
import { KeyboardStatus, type KeyboardFeedback } from "@/src/components/station/keyboard-status";
import { IntakeForm } from "./intake-form";
import {
  loadCustomer,
  loadIntake,
  printReceipt,
  reprintToteTags,
  unlockIntake,
  type LoadedIntake,
} from "./intake-data";
import { STATE_LABELS, coolerBadge, intakeTimeline, lineToRow } from "./intake-form-state";
import {
  IntakeSavedSkeleton,
  IntakeSavedView,
  IntakeShell,
  refusal,
  savedNextStep,
  type Prompt,
  type SavedIntake,
} from "./intake-view";
import { managerElevation, sessionLabel, type StationSession } from "./use-station-session";
import type { CustomerHit } from "@/components/customers/customer-search-state";

const name = {
  species: (c: string) => (isSpeciesCode(c) ? SPECIES[c].name : c),
  condition: (c: string) => (isConditionCode(c) ? CONDITIONS[c].name : c),
  method: (c: string) => (isMethodCode(c) ? METHODS[c].name : c),
};

/** The loaded rows as the saved view shows them. */
export function savedIntake(data: LoadedIntake, now: Date): SavedIntake | null {
  const { intake, lines, charges, totes } = data;
  if (!intake) return null;
  const badge = coolerBadge(intake.state, intake.intake_at, now);
  const editable = intake.state === "draft" || intake.state === "holding";
  return {
    number: intake.number,
    customer: intake.customer?.name ?? null,
    phone: intake.customer?.phone ?? null,
    chips: [
      STATE_LABELS[intake.state] ?? intake.state,
      ...(badge ? [badge] : []),
      ...(intake.locked ? ["Locked"] : []),
      ...(intake.is_lodge_guest ? ["Lodge"] : []),
    ],
    flags: [
      ...(intake.fast_pass ? ["FAST PASS"] : []),
      ...(intake.dirty_fish ? ["DIRTY"] : []),
      ...(intake.ribbing ? ["RIBBING"] : []),
    ],
    lines: lines.map((l) => ({
      id: l.id,
      name: name.species(l.species_code),
      detail: [
        name.condition(l.condition_code),
        name.method(l.method_code) +
          (l.fillets_pct !== null ? ` ${l.fillets_pct}/${100 - l.fillets_pct}` : ""),
        ...(l.skin_off ? ["skin off"] : []),
        ...(l.notes ? [l.notes] : []),
      ].join(" · "),
      lb: l.lb,
      estYield: l.est_yield_lb,
    })),
    totalLb: intake.total_incoming_lb,
    totalEstYield: intake.total_est_yield_lb,
    toteCount: intake.tote_count,
    notes: [
      ...(intake.dirty_notes ? [{ label: "Dirty fish", text: intake.dirty_notes }] : []),
      ...(intake.cut_notes ? [{ label: "Cut", text: intake.cut_notes }] : []),
      ...(intake.processing_notes ? [{ label: "Processing", text: intake.processing_notes }] : []),
    ],
    charges: charges.map((c) => ({
      id: c.id,
      description: c.description,
      qty: c.qty,
      unitPrice: c.unit_price,
      amount: c.amount,
      state: c.state,
    })),
    timeline: intakeTimeline(intake),
    totes: totes.map((t) => ({
      no: t.tote_no,
      of: t.of_count,
      qr: t.qr,
      queued: t.print_job_id !== null,
    })),
    canUnlock: intake.locked && editable,
    receiptHref: `/intake/receipt/${intake.id}`,
  };
}

/**
 * A saved intake: read-only while locked, with the post-save actions (New Intake, Reprint, Print
 * Receipt, manager Unlock), tote tags, lines, charges with their per-lb rates and the timeline.
 * Unlocking switches to the edit form; saving locks it again.
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
  const router = useRouter();
  const [data, setData] = useState<LoadedIntake | null>(null);
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [feedback, setFeedback] = useState<KeyboardFeedback | null>(
    notice ? { ok: true, text: notice, event: 0 } : null,
  );
  const [loadError, setLoadError] = useState("");
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
        setLoadError("");
      })
      .catch(() => live && setLoadError("Order unavailable. Check the connection and reload."));
    return () => {
      live = false;
    };
  }, [client, intakeId, version]);

  const say = (ok: boolean, text: string) => setFeedback({ ok, text, event: Date.now() });
  async function run(label: string, fn: () => Promise<{ printer_missing: boolean }>) {
    setBusy(true);
    try {
      const r = await fn();
      say(
        true,
        r.printer_missing ? `${label}: no printer is set up for this site.` : `${label} queued.`,
      );
      refresh();
    } catch (err) {
      say(false, refusal(err instanceof Error ? err.message : `${label} failed`, "Tap it again."));
    } finally {
      setBusy(false);
    }
  }

  const intake = data?.intake ?? null;
  const shell = (prompt: Prompt, body: ReactNode) => (
    <IntakeShell
      site={session.siteName}
      operator={sessionLabel(session)}
      prompt={prompt}
      status={
        <KeyboardStatus
          feedback={feedback}
          notice={loadError ? { tone: "error", text: loadError } : null}
        />
      }
    >
      {body}
    </IntakeShell>
  );

  if (!data) return shell({ next: "Opening the order", step: 3 }, <IntakeSavedSkeleton />);
  if (!intake)
    return shell(
      { next: "Tap New Intake to start an order", step: 0, tone: "warn" },
      <section className="station-card st-hero-empty" aria-label="Order">
        <h2>Order not found</h2>
        <p>It may have been cancelled. Start a new order, or open one from Orders.</p>
      </section>,
    );

  if (!intake.locked && customer && (intake.state === "draft" || intake.state === "holding")) {
    return (
      <IntakeForm
        session={session}
        initial={{
          intakeId: intake.id,
          number: intake.number,
          customer,
          rows: data.lines.map(lineToRow),
          toteCount: intake.tote_count,
          dirtyFish: intake.dirty_fish,
          dirtyNotes: intake.dirty_notes ?? "",
          cutNotes: intake.cut_notes ?? "",
          processingNotes: intake.processing_notes ?? "",
          fastPass: intake.fast_pass,
        }}
        onSaved={(r) => {
          say(
            true,
            r.printer_missing
              ? `${r.number} saved. No tote printer is set up for this site.`
              : `${r.number} saved; ${r.tote_jobs_queued} tote tags queued.`,
          );
          refresh();
        }}
      />
    );
  }

  const saved = savedIntake(data, now)!;
  return shell(
    savedNextStep(saved),
    <>
      <IntakeSavedView
        intake={saved}
        busy={busy || pinOpen}
        on={{
          newIntake: () => router.push("/intake"),
          reprint: () => void run("Tote tags", () => reprintToteTags(client, intake.id)),
          printReceipt: () => void run("Receipt", () => printReceipt(client, intake.id)),
          unlock: () => setPinOpen(true),
        }}
      />
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
            say(true, `${intake.number} unlocked. Change it, then save to lock it again.`);
            refresh();
            return { ok: true };
          }}
        />
      )}
    </>,
  );
}
