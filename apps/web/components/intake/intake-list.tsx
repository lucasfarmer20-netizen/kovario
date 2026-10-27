"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { listIntakes, type IntakeState } from "./intake-data";
import { STATE_LABELS, coolerBadge } from "./intake-form-state";
import type { StationSession } from "./use-station-session";

type Row = Awaited<ReturnType<typeof listIntakes>>[number];

/** Recent intakes, newest first, with the hours-in-cooler badge on holding ones. */
export function IntakeList({ session }: { session: StationSession }) {
  const [state, setState] = useState<IntakeState | "">("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let live = true;
    listIntakes(session.client, state || null).then(
      (r) => {
        if (!live) return;
        setRows(r);
        setNow(new Date());
      },
      () => live && setError("Intakes unavailable; reload."),
    );
    return () => {
      live = false;
    };
  }, [session.client, state]);
  return (
    <section className="station-card" aria-label="Intakes">
      <label className="intake-filter">
        State{" "}
        <select value={state} onChange={(e) => setState(e.target.value as IntakeState | "")}>
          <option value="">All</option>
          {Object.entries(STATE_LABELS).map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      {!rows ? (
        <p>Loading…</p>
      ) : rows.length === 0 ? (
        <p>No intakes.</p>
      ) : (
        <ul className="station-queue intake-list">
          {rows.map((r) => {
            const badge = coolerBadge(r.state, r.intake_at, now);
            return (
              <li key={r.id}>
                <Link href={`/intake/${r.id}`}>{r.number}</Link>
                <span>{r.customer?.name}</span>
                <span className="station-badge">{STATE_LABELS[r.state] ?? r.state}</span>
                {badge && <span className="station-badge">{badge}</span>}
                <span>
                  {r.total_incoming_lb} lb · {r.tote_count} totes
                </span>
                {r.fast_pass && <span className="station-badge">FAST PASS</span>}
                {r.dirty_fish && <span className="station-badge">DIRTY</span>}
                {r.ribbing && <span className="station-badge">RIBBING</span>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
