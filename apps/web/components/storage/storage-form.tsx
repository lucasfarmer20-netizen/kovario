"use client";
import { useEffect, useRef, useState } from "react";
import { formatPhone } from "rules";
import { CustomerSearch } from "@/components/customers/customer-search";
import type { CustomerHit } from "@/components/customers/customer-search-state";
import { createCustomer, searchCustomers } from "@/components/intake/intake-data";
import type { StationSession } from "@/components/intake/use-station-session";
import { confirmStorageIntake, listLocations, type ConfirmResult } from "./storage-data";
import { confirmPayload, emptyBox, type BoxRow } from "./storage-state";

/**
 * Storage intake (docs/06-STATIONS-UX.md): customer → location → boxes (weight,
 * description) → Confirm → storage box labels (QR FL:SBOX) + optional receipt.
 */
export function StorageForm({
  session,
  onConfirmed,
}: {
  session: StationSession;
  onConfirmed: (result: ConfirmResult) => void;
}) {
  const { client, claims } = session;
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [locations, setLocations] = useState<{ id: string; code: string }[]>([]);
  const [locationId, setLocationId] = useState("");
  const [rows, setRows] = useState<BoxRow[]>(() => [emptyBox()]);
  const [notes, setNotes] = useState("");
  const [printReceipt, setPrintReceipt] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // One id per confirm intent: a retry after a lost response replays; any edit starts a new one.
  const actionId = useRef<string | null>(null);

  useEffect(() => {
    listLocations(client).then(setLocations, () => setError("Locations unavailable; reload."));
  }, [client]);

  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      actionId.current = null;
      setError("");
      set(v);
    };
  const setRow = (key: string, patch: Partial<BoxRow>) =>
    edit(setRows)(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function confirm() {
    const built = confirmPayload({
      customerId: customer?.id ?? null,
      locationId,
      notes,
      printReceipt,
      rows,
    });
    if ("errors" in built) {
      setError(built.errors.join(" "));
      return;
    }
    setSaving(true);
    setError("");
    try {
      actionId.current ??= crypto.randomUUID();
      const result = await confirmStorageIntake(client, actionId.current, built.payload);
      actionId.current = null;
      onConfirmed(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Confirm failed; try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="station-workspace intake-workspace">
      <section className="station-card intake-form" aria-label="Storage intake">
        <h2>New storage intake</h2>
        {customer ? (
          <div className="intake-customer">
            <div>
              <strong>{customer.name}</strong>{" "}
              {customer.phone && <span>{formatPhone(customer.phone)}</span>}
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

        <div className="intake-fields">
          <label>
            Location{" "}
            <select value={locationId} onChange={(e) => edit(setLocationId)(e.target.value)}>
              <option value="">— not placed yet —</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code}
                </option>
              ))}
            </select>
          </label>
        </div>

        <h3>Boxes</h3>
        <table className="intake-lines">
          <thead>
            <tr>
              <th>Box</th>
              <th>Weight lb</th>
              <th>Description</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.key}>
                <td>Box {i + 1}</td>
                <td>
                  <input
                    aria-label={`Box ${i + 1} weight`}
                    inputMode="decimal"
                    size={6}
                    value={row.weight}
                    onChange={(e) => setRow(row.key, { weight: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    aria-label={`Box ${i + 1} description`}
                    value={row.description}
                    onChange={(e) => setRow(row.key, { description: e.target.value })}
                  />
                </td>
                <td>
                  {rows.length > 1 && (
                    <button
                      type="button"
                      aria-label={`Remove box ${i + 1}`}
                      onClick={() => edit(setRows)(rows.filter((r) => r.key !== row.key))}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="station-actions">
          <button type="button" onClick={() => edit(setRows)([...rows, emptyBox()])}>
            Add box
          </button>
        </div>

        <div className="intake-fields">
          <label>
            Notes <textarea value={notes} onChange={(e) => edit(setNotes)(e.target.value)} />
          </label>
          <label className="intake-toggle">
            <input
              type="checkbox"
              checked={printReceipt}
              onChange={(e) => edit(setPrintReceipt)(e.target.checked)}
            />{" "}
            Print receipt
          </label>
        </div>

        {error && (
          <p className="station-feedback station-rejected" role="alert">
            {error}
          </p>
        )}
        <div className="station-actions">
          <button type="button" disabled={saving} onClick={() => void confirm()}>
            {saving
              ? "Confirming…"
              : `Confirm & Print ${rows.length} Label${rows.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </section>
    </div>
  );
}
