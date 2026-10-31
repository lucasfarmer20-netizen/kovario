"use client";
import { useEffect, useRef, useState } from "react";
import { CustomerSearch } from "@/components/customers/customer-search";
import { createCustomer, searchCustomers } from "@/components/intake/intake-data";
import { refusal } from "@/components/intake/intake-view";
import { sessionLabel, type StationSession } from "@/components/intake/use-station-session";
import { useOnline } from "@/src/components/station/connection-chip";
import { KeyboardStatus, type KeyboardFeedback } from "@/src/components/station/keyboard-status";
import {
  confirmStorageIntake,
  listLocations,
  printLabels,
  type ConfirmResult,
  type LabelsQueued,
} from "./storage-data";
import { confirmPayload, emptyBox } from "./storage-state";
import {
  STORAGE_STEPS,
  StorageFormView,
  StorageShell,
  LOCATION_FIELD_ID,
  boxFieldId,
  storageNextStep,
  type StorageFormValues,
} from "./storage-view";

const NO_CUSTOMER = "Pick or create the customer.";

/**
 * Storage intake (docs/06-STATIONS-UX.md): customer → location → boxes (weight,
 * description) → Confirm → storage box labels (QR FL:SBOX) + optional receipt, in the Cold
 * storage console (step row, next step line, the confirm result in the status tile).
 */
export function StorageForm({
  session,
  onConfirmed,
}: {
  session: StationSession;
  /** `labels` is the label print outcome, or the error that kept them from queuing. */
  onConfirmed: (result: ConfirmResult, labels: LabelsQueued | { error: string }) => void;
}) {
  const { client, claims } = session;
  const online = useOnline();
  const [locations, setLocations] = useState<{ id: string; code: string }[] | null>(null);
  const [values, setValues] = useState<StorageFormValues>(() => ({
    customer: null,
    locationId: "",
    rows: [emptyBox()],
    notes: "",
  }));
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<KeyboardFeedback | null>(null);
  const [loadError, setLoadError] = useState("");
  // One id per confirm intent: a retry after a lost response replays; any edit starts a new one.
  const actionId = useRef<string | null>(null);

  useEffect(() => {
    listLocations(client).then(setLocations, () => {
      setLocations([]);
      setLoadError("Locations unavailable. Check the connection and reload.");
    });
  }, [client]);

  const change = (patch: Partial<StorageFormValues>) => {
    actionId.current = null;
    setFeedback(null);
    setValues((v) => ({ ...v, ...patch }));
  };
  const focusLater = (id: string) =>
    requestAnimationFrame(() => document.getElementById(id)?.focus());

  const built = confirmPayload({
    customerId: values.customer?.id ?? null,
    locationId: values.locationId,
    notes: values.notes,
    rows: values.rows,
  });
  const prompt = storageNextStep({
    customer: values.customer !== null,
    location: values.locationId !== "",
    rows: values.rows,
    problems: "errors" in built ? built.errors.filter((e) => e !== NO_CUSTOMER) : [],
    online,
  });

  async function confirm() {
    if (prompt.confirmWhy || "errors" in built) return;
    setSaving(true);
    setFeedback(null);
    try {
      actionId.current ??= crypto.randomUUID();
      const result = await confirmStorageIntake(client, actionId.current, built.payload);
      actionId.current = null;
      // The intake is stored; a label failure is reported, and Reprint Labels retries it.
      const labels = await printLabels(client, result.labels).catch((err: unknown) => ({
        error: err instanceof Error ? err.message : "labels did not queue",
      }));
      onConfirmed(result, labels);
    } catch (err) {
      setFeedback({
        ok: false,
        text: refusal(
          err instanceof Error ? err.message : "Confirm did not go through",
          "Check the boxes and tap Confirm again.",
        ),
        event: Date.now(),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <StorageShell
      site={session.siteName}
      operator={sessionLabel(session)}
      prompt={prompt}
      steps={STORAGE_STEPS}
      status={
        <KeyboardStatus
          feedback={feedback}
          notice={
            loadError
              ? { tone: "error", text: loadError }
              : !online
                ? {
                    tone: "info",
                    text: "Offline. Confirm needs a connection; the boxes stay as typed.",
                  }
                : null
          }
        />
      }
    >
      <StorageFormView
        loading={locations === null}
        locations={locations ?? []}
        values={values}
        confirmWhy={prompt.confirmWhy}
        saving={saving}
        customerSearch={
          <CustomerSearch
            autoFocus
            label="Customer phone or name"
            search={(q) => searchCustomers(client, claims.orgId, q)}
            create={(input) => createCustomer(client, input)}
            onSelect={(customer) => {
              change({ customer });
              // The keyboard goes on to where it is stored, then the boxes below it.
              focusLater(LOCATION_FIELD_ID);
            }}
          />
        }
        on={{
          changeCustomer: () => change({ customer: null }),
          location: (locationId) => change({ locationId }),
          setRow: (key, patch) =>
            change({ rows: values.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) }),
          addRow: () => {
            const row = emptyBox();
            change({ rows: [...values.rows, row] });
            focusLater(boxFieldId(row.key));
          },
          removeRow: (key) => change({ rows: values.rows.filter((r) => r.key !== key) }),
          notes: (notes) => change({ notes }),
          confirm: () => void confirm(),
        }}
      />
    </StorageShell>
  );
}
