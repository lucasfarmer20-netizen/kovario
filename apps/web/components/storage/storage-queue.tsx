"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { StationSession } from "@/components/intake/use-station-session";
import { listStorageIntakes, type StorageState } from "./storage-data";
import { STORAGE_STATE_LABELS, boxRollup, daysLabel } from "./storage-state";

type Row = Awaited<ReturnType<typeof listStorageIntakes>>[number];

/**
 * Storage queue: intakes with boxes in the freezer (stored + partly picked up) oldest first,
 * with the box rollup, days stored of the oldest box, and pending pickup batches.
 */
export function StorageQueue({ session }: { session: StationSession }) {
  const [state, setState] = useState<StorageState | "">("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    listStorageIntakes(session.client, state || null).then(
      (r) => live && setRows(r),
      () => live && setError("Storage queue unavailable; reload."),
    );
    return () => {
      live = false;
    };
  }, [session.client, state]);
  return (
    <section className="station-card" aria-label="Storage queue">
      <label className="intake-filter">
        Show{" "}
        <select value={state} onChange={(e) => setState(e.target.value as StorageState | "")}>
          <option value="">In storage (stored + partial)</option>
          {(["stored", "partial", "released", "cancelled"] as const).map((code) => (
            <option key={code} value={code}>
              {STORAGE_STATE_LABELS[code]}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      {!rows ? (
        <p>Loading…</p>
      ) : rows.length === 0 ? (
        <p>Nothing in storage.</p>
      ) : (
        <ul className="station-queue intake-list">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={`/storage/${r.id}`}>{r.number}</Link>
              <span>{r.customer?.name}</span>
              <span className="station-badge">{STORAGE_STATE_LABELS[r.state] ?? r.state}</span>
              <span>{boxRollup(r.active_box_count, r.box_count)}</span>
              {r.days !== null && <span className="station-badge">{daysLabel(r.days)}</span>}
              {r.location && <span>{r.location.code}</span>}
              {r.pending_batches > 0 && (
                <span className="station-badge">
                  {r.pending_batches} pickup{r.pending_batches === 1 ? "" : "s"} awaiting payment
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
