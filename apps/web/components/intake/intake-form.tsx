"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildIntakeDraft, savePayload } from "rules";
import { CustomerSearch } from "@/components/customers/customer-search";
import type { CustomerHit } from "@/components/customers/customer-search-state";
import { useOnline } from "@/src/components/station/connection-chip";
import { KeyboardStatus, type KeyboardFeedback } from "@/src/components/station/keyboard-status";
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
  emptyRow,
  lineGap,
  parseToteCount,
  rowsToLines,
  updateRow,
  type LineRow,
  type OrgReference,
} from "./intake-form-state";
import {
  IntakeFormView,
  IntakeShell,
  fieldId,
  intakeNextStep,
  refusal,
  type Draft,
  type IntakeFormValues,
} from "./intake-view";
import { sessionLabel, type StationSession } from "./use-station-session";

export type IntakeFormInitial = {
  intakeId: string;
  /** The order's number: the form is editing an order a manager unlocked. */
  number?: string;
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
 * Fast Pass → live price panel → Save & Print Tote Tags, in the Intake console (step row, next
 * step line, the save result in the status tile). With `initial` it edits an intake a manager
 * unlocked; saving locks it again.
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
  const online = useOnline();
  const [reference, setReference] = useState<OrgReference | null>(null);
  const [ctx, setCtx] = useState<PriceContext | null>(null);
  const [values, setValues] = useState<IntakeFormValues>(() => ({
    customer: initial?.customer ?? null,
    rows: initial?.rows ?? [emptyRow()],
    toteCount: String(initial?.toteCount ?? 1),
    dirtyFish: initial?.dirtyFish ?? false,
    dirtyNotes: initial?.dirtyNotes ?? "",
    cutNotes: initial?.cutNotes ?? "",
    processingNotes: initial?.processingNotes ?? "",
    fastPass: initial?.fastPass ?? false,
    printReceipt: false,
  }));
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<KeyboardFeedback | null>(null);
  const [loadError, setLoadError] = useState("");
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  // One id per save intent: a retry after a lost response replays; any edit starts a new one.
  const actionId = useRef<string | null>(null);
  const intakeId = initial?.intakeId ?? null;
  const customerId = values.customer?.id ?? null;

  useEffect(() => {
    loadReference(client).then(setReference, () =>
      setLoadError("Species unavailable. Check the connection and reload."),
    );
  }, [client]);
  useEffect(() => {
    loadPriceContext(client, customerId, intakeId).then(setCtx, () =>
      setLoadError("Rates unavailable. Check the connection and reload."),
    );
  }, [client, customerId, intakeId]);

  const focusOn = (id: string) => setFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }));
  /** Every edit starts a new save intent and clears a refusal it may have fixed. */
  const change = (patch: Partial<IntakeFormValues>) => {
    actionId.current = null;
    setFeedback(null);
    setValues((v) => ({ ...v, ...patch }));
  };

  const parsed = useMemo(() => rowsToLines(values.rows), [values.rows]);
  const draft = useMemo((): Draft => {
    if (!ctx || parsed.lines.length === 0) return null;
    try {
      return buildIntakeDraft(parsed.lines, pricingFrom(ctx, values.fastPass));
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Line not allowed" };
    }
  }, [ctx, parsed.lines, values.fastPass]);
  const prompt = intakeNextStep({
    customer: values.customer !== null,
    rows: values.rows,
    toteCount: values.toteCount,
    priced: ctx !== null,
    draft,
    online,
  });

  async function save() {
    const totes = parseToteCount(values.toteCount);
    // The view holds Save until the order is complete; this is the same check, kept as a guard.
    if (prompt.saveWhy || !values.customer || !totes || parsed.errors.length > 0) return;
    setSaving(true);
    setFeedback(null);
    try {
      const payload = savePayload(
        {
          intakeId,
          customerId: values.customer.id,
          toteCount: totes,
          dirtyFish: values.dirtyFish,
          dirtyNotes: values.dirtyNotes,
          cutNotes: values.cutNotes,
          processingNotes: values.processingNotes,
          fastPass: values.fastPass,
          printReceipt: values.printReceipt,
        },
        parsed.lines,
      );
      actionId.current ??= crypto.randomUUID();
      const result = await saveIntake(client, actionId.current, payload);
      actionId.current = null;
      onSaved(result);
    } catch (err) {
      setFeedback({
        ok: false,
        text: refusal(
          err instanceof Error ? err.message : "Save did not go through",
          "Check the order and tap Save again.",
        ),
        event: Date.now(),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <IntakeShell
      site={session.siteName}
      operator={sessionLabel(session)}
      prompt={prompt}
      status={
        <KeyboardStatus
          feedback={feedback}
          notice={
            loadError
              ? { tone: "error", text: loadError }
              : !online
                ? {
                    tone: "info",
                    text: "Offline. Saving needs a connection; the order stays as typed.",
                  }
                : null
          }
        />
      }
    >
      <IntakeFormView
        reference={reference}
        ctx={ctx}
        draft={draft}
        values={values}
        editing={initial?.number}
        focus={focus}
        saveWhy={prompt.saveWhy}
        saving={saving}
        customerSearch={
          <CustomerSearch
            autoFocus
            label="Customer phone or name"
            search={(q) => searchCustomers(client, claims.orgId, q)}
            create={(input) => createCustomer(client, input)}
            onSelect={(customer) => {
              change({ customer });
              // The keyboard goes on to the first line that still needs its species.
              const row = values.rows.find((r) => lineGap(r) !== null) ?? values.rows[0];
              if (row) focusOn(fieldId(row.key, "species"));
            }}
          />
        }
        on={{
          changeCustomer: () => change({ customer: null }),
          setRow: (key, patch) => {
            if (!reference) return;
            const before = values.rows.find((r) => r.key === key);
            const rows = values.rows.map((r) =>
              r.key === key ? updateRow(reference, r, patch) : r,
            );
            change({ rows });
            // Once a line's method is set (picked, or the only one), its weight is next.
            const after = rows.find((r) => r.key === key);
            if (after && before && !before.method && after.method && !after.lb.trim())
              focusOn(fieldId(key, "lb"));
          },
          addRow: () => {
            const row = emptyRow();
            change({ rows: [...values.rows, row] });
            focusOn(fieldId(row.key, "species"));
          },
          removeRow: (key) => change({ rows: values.rows.filter((r) => r.key !== key) }),
          set: (field, value) => change({ [field]: value } as Partial<IntakeFormValues>),
          save: () => void save(),
        }}
      />
    </IntakeShell>
  );
}
