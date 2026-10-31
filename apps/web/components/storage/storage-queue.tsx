"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { sessionLabel, type StationSession } from "@/components/intake/use-station-session";
import { KeyboardStatus } from "@/src/components/station/keyboard-status";
import { listStorageIntakes, type StorageState } from "./storage-data";
import { STORAGE_STATE_LABELS, boxRollup, daysLabel } from "./storage-state";
import { StorageQueueView, StorageShell, type StorageQueueRow } from "./storage-view";

type Row = Awaited<ReturnType<typeof listStorageIntakes>>[number];

/** A queued storage order as a tile: customer, state, box rollup, location; days stored. */
export function queueRow(r: Row): StorageQueueRow {
  return {
    id: r.id,
    number: r.number,
    detail: [
      r.customer?.name,
      STORAGE_STATE_LABELS[r.state] ?? r.state,
      boxRollup(r.active_box_count, r.box_count),
      r.location?.code,
    ]
      .filter(Boolean)
      .join(" · "),
    age: r.days === null ? undefined : daysLabel(r.days),
    flags:
      r.pending_batches > 0
        ? [`${r.pending_batches} pickup${r.pending_batches === 1 ? "" : "s"} awaiting payment`]
        : [],
  };
}

/**
 * Storage queue: intakes with boxes in the freezer (stored + partly picked up) oldest first,
 * with the box rollup, days stored of the oldest box, and pending pickup batches.
 */
export function StorageQueue({ session }: { session: StationSession }) {
  const router = useRouter();
  const [state, setState] = useState<StorageState | "">("");
  const [rows, setRows] = useState<StorageQueueRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    listStorageIntakes(session.client, state || null).then(
      (r) => {
        if (!live) return;
        setRows(r.map(queueRow));
        setError("");
      },
      () => live && setError("Storage queue unavailable. Check the connection and reload."),
    );
    return () => {
      live = false;
    };
  }, [session.client, state]);
  return (
    <StorageShell
      site={session.siteName}
      operator={sessionLabel(session)}
      prompt={{ next: "Tap a storage order to open it" }}
      status={<KeyboardStatus feedback={null} />}
    >
      <StorageQueueView
        rows={rows}
        filter={state}
        error={error}
        on={{
          filter: (s) => {
            setRows(null);
            setState(s as StorageState | "");
          },
          open: (id) => router.push(`/storage/${id}`),
        }}
      />
    </StorageShell>
  );
}
