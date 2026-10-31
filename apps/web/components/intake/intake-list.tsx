"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { KeyboardStatus } from "@/src/components/station/keyboard-status";
import { listIntakes, type IntakeState } from "./intake-data";
import { STATE_LABELS, coolerBadge } from "./intake-form-state";
import { IntakeListView, IntakeShell, type IntakeListRow } from "./intake-view";
import { sessionLabel, type StationSession } from "./use-station-session";

type Row = Awaited<ReturnType<typeof listIntakes>>[number];

/** A listed intake as an order tile: customer, state, lb and totes; hours in the cooler. */
export function listRow(r: Row, now: Date): IntakeListRow {
  return {
    id: r.id,
    number: r.number,
    detail: [
      r.customer?.name,
      STATE_LABELS[r.state] ?? r.state,
      `${r.total_incoming_lb} lb`,
      `${r.tote_count} ${r.tote_count === 1 ? "tote" : "totes"}`,
    ]
      .filter(Boolean)
      .join(" · "),
    age: coolerBadge(r.state, r.intake_at, now) ?? undefined,
    flags: [
      ...(r.fast_pass ? ["FAST PASS"] : []),
      ...(r.dirty_fish ? ["DIRTY"] : []),
      ...(r.ribbing ? ["RIBBING"] : []),
    ],
  };
}

/** Recent intakes, newest first, with the hours-in-cooler badge on holding ones. */
export function IntakeList({ session }: { session: StationSession }) {
  const router = useRouter();
  const [state, setState] = useState<IntakeState | "">("");
  const [rows, setRows] = useState<IntakeListRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    listIntakes(session.client, state || null).then(
      (r) => {
        if (!live) return;
        const now = new Date();
        setRows(r.map((row) => listRow(row, now)));
        setError("");
      },
      () => live && setError("Orders unavailable. Check the connection and reload."),
    );
    return () => {
      live = false;
    };
  }, [session.client, state]);
  return (
    <IntakeShell
      site={session.siteName}
      operator={sessionLabel(session)}
      prompt={{ next: "Tap an order to open it" }}
      steps={false}
      status={<KeyboardStatus feedback={null} />}
    >
      <IntakeListView
        rows={rows}
        filter={state}
        error={error}
        on={{
          filter: (s) => {
            setRows(null);
            setState(s as IntakeState | "");
          },
          open: (id) => router.push(`/intake/${id}`),
        }}
      />
    </IntakeShell>
  );
}
