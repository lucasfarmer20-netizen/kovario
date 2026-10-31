"use client";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Search, Undo2, X } from "lucide-react";
import type { FilletryClient } from "db";
import {
  formatVariance,
  pullBackProblem,
  rankSuspects,
  suggestMoves,
  SUSPECT_STATUS_LABELS,
  SUSPECT_STATUSES,
  suspectsWaiting,
  type Suspect,
  type SuspectStatus,
  type SuggestedMove,
} from "rules";
import { BAND_LABEL, lineBand } from "@/components/variance/now-in-blast";
import { DisabledReason } from "@/src/components/station/next-step";

/** The divider above members whose variance has the flagged order's sign (DECISION-33). */
export const UNLIKELY_SOURCE = "Same direction: unlikely source";

/** One member of public.variance_suspect_group (#88). */
export type SuspectRow = {
  center_intake_id: string;
  hold_id: string | null;
  intake_id: string;
  position: number;
  intake_number: string;
  state: string;
  status: string;
  waiting: boolean;
  expected_lb: number;
  actual_lb: number;
  variance_pct: number | null;
  limit_pct: number;
  band: string;
  species: string[];
};

/** An occupied vessel of a group member: the bin a manager can move. */
export type SuspectBinRow = {
  id: string;
  intake_id: string;
  weight_lb: number;
  is_exchange: boolean;
  asset_tag: { code: string } | null;
};

function status(row: SuspectRow): SuspectStatus {
  return (SUSPECT_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as SuspectStatus)
    : "upstream";
}

export function toSuspect(row: SuspectRow): Suspect {
  return {
    intakeId: row.intake_id,
    number: row.intake_number,
    position: row.position,
    status: status(row),
    expectedLb: Number(row.expected_lb),
    actualLb: Number(row.actual_lb),
    species: row.species,
  };
}

/** "INT-0003 · −40% · over limit · salmon · 50 lb · reconciled". */
export function suspectLine(row: SuspectRow): string {
  const band = lineBand(row.band);
  const species = row.species.length ? row.species.join(", ") : "no species";
  return [
    row.intake_number,
    formatVariance(row.variance_pct),
    BAND_LABEL[band],
    species,
    `${Number(row.expected_lb)} lb`,
    SUSPECT_STATUS_LABELS[status(row)],
  ].join(" · ");
}

/** "Basket 0042 · 20 lb" / "Exchange basket · 30 lb" (docs/11-FLOOR-WORDING.md). */
export function binLabel(bin: SuspectBinRow): string {
  const name = bin.is_exchange
    ? "Exchange basket"
    : bin.asset_tag
      ? `Basket ${bin.asset_tag.code}`
      : "Untagged basket";
  return `${name} · ${Number(bin.weight_lb)} lb`;
}

/** binLabel mid-sentence: "Move basket 0042 · 20 lb …". */
function movingLabel(bin: SuspectBinRow): string {
  const label = binLabel(bin);
  return label[0]!.toLowerCase() + label.slice(1);
}

/** The picker's group for `intakeId` and its members' bins; reloads on `refresh`. */
export function useSuspectGroup(client: FilletryClient, intakeId: string | null) {
  // Kept with the intake it was loaded for: a new centre (or a late reply for the previous one)
  // never shows another group.
  const [loaded, setLoaded] = useState<{
    intakeId: string;
    rows: SuspectRow[];
    bins: SuspectBinRow[];
  } | null>(null);
  const [error, setError] = useState(false);
  const refresh = useCallback(async () => {
    if (!intakeId) return;
    const group = await client.rpc("variance_suspect_group", { p_intake_id: intakeId });
    if (group.error) {
      setError(true);
      return;
    }
    const members = (group.data ?? []) as SuspectRow[];
    const vessels = members.length
      ? await client
          .from("vessel")
          .select("id,intake_id,weight_lb,is_exchange,asset_tag!vessel_asset_tag_id_fkey(code)")
          .in(
            "intake_id",
            members.map((m) => m.intake_id),
          )
          .eq("lifecycle_state", "occupied")
          .order("id")
      : { data: [], error: null };
    if (vessels.error) {
      setError(true);
      return;
    }
    setError(false);
    setLoaded({ intakeId, rows: members, bins: (vessels.data ?? []) as SuspectBinRow[] });
  }, [client, intakeId]);
  const current = loaded && loaded.intakeId === intakeId ? loaded : null;
  return { rows: current?.rows ?? [], bins: current?.bins ?? [], error, refresh };
}

/**
 * The suspect picker (#88): the hold group, the flagged (or tapped) intake first and its suspects
 * most likely first (rules: rankSuspects), each with variance, species, size and status;
 * same-direction members follow below the "Same direction: unlikely source" divider, as the
 * rules group them (DECISION-33), with no suggested move. Bin
 * moves are suggested only once every member is reconciled (rules: suggestMoves); until then the
 * picker names the members still waiting. A manager moves a bin between members at reconcile, or
 * pulls a member in blast back to reconcile with a reason. Wet-glove: plain buttons, no focus
 * trap; the reason is typed in an explicit editing mode (`editingReason`) while the caller
 * pauses the station scanner, as for the sign-off note.
 */
export function SuspectPicker({
  rows,
  bins,
  error = false,
  disabled,
  editingReason,
  onEditReason,
  onMove,
  onPullBack,
  onClose,
}: {
  rows: readonly SuspectRow[];
  bins: readonly SuspectBinRow[];
  error?: boolean;
  disabled: boolean;
  editingReason: boolean;
  onEditReason: (open: boolean) => void;
  onMove: (vesselId: string, toIntakeId: string, centerIntakeId: string) => void;
  onPullBack: (intakeId: string, reason: string) => void;
  onClose: () => void;
}) {
  const [selectedBin, setSelectedBin] = useState<string | null>(null);
  const [pullBackFor, setPullBackFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const center = rows.find((r) => r.position === 0);
  const byId = new Map(rows.map((r) => [r.intake_id, r]));
  const number = (id: string) => byId.get(id)?.intake_number ?? id;
  const suspects = rows.map(toSuspect);
  const flagged = center ? toSuspect(center) : null;
  const ranked = flagged ? rankSuspects(flagged, suspects) : { suspects: [], unlikely: [] };
  const grouped = new Set([...ranked.suspects, ...ranked.unlikely].map((s) => s.intakeId));
  const waiting = suspectsWaiting(rows.map((r) => ({ ...r, status: status(r) })));
  const moves: SuggestedMove[] = flagged
    ? suggestMoves(
        flagged,
        suspects,
        bins.map((b) => ({ vesselId: b.id, intakeId: b.intake_id, weightLb: Number(b.weight_lb) })),
      )
    : [];
  const atReconcile = rows.filter((r) => r.state === "reconcile");
  const bin = bins.find((b) => b.id === selectedBin);
  // Open until the intake has left blast: after a successful pull back the refreshed group shows
  // it reconciled and the form closes; a failure (refused, PIN cancelled) keeps the typed reason.
  const pullBackRow =
    pullBackFor && byId.get(pullBackFor)?.status === "in_blast" ? byId.get(pullBackFor) : undefined;
  // Left blast (pulled back here or by another manager): empty the form so the order never
  // reopens with a stale reason (#103).
  if (pullBackFor !== null && pullBackRow === undefined) {
    setPullBackFor(null);
    setReason("");
  }
  // No form, no reason editing: the station's scanner resumes (wet-glove rule 6, #103).
  const formOpen = pullBackRow !== undefined;
  useEffect(() => {
    if (editingReason && !formOpen) onEditReason(false);
  }, [editingReason, formOpen, onEditReason]);
  const problem = pullBackRow
    ? pullBackProblem(pullBackRow.state as Parameters<typeof pullBackProblem>[0], reason)
    : null;
  const startPullBack = (intakeId: string) => {
    setPullBackFor(intakeId);
    setReason("");
  };
  const row = (r: SuspectRow, label?: string) => (
    <li key={r.intake_id} className={`station-band station-band-${lineBand(r.band)} rc-suspect`}>
      {label && <strong>{label} </strong>}
      <span className="rc-suspect-line">{suspectLine(r)}</span>
      {r.status === "in_blast" && (
        <button
          type="button"
          className="st-btn-secondary"
          disabled={disabled}
          onClick={() => startPullBack(r.intake_id)}
        >
          <Undo2 size={20} aria-hidden />
          Pull back {r.intake_number}
        </button>
      )}
    </li>
  );
  if (!center)
    return (
      <section className="station-card rc-suspects" aria-label="Suspect picker">
        <div className="rc-panel-head">
          <h3 className="rc-panel-title">
            <span className="rc-panel-icon" aria-hidden>
              <Search size={22} strokeWidth={2.6} />
            </span>
            <span className="rc-panel-kicker">SUSPECTS</span>
          </h3>
          <button type="button" className="st-btn-secondary" onClick={onClose}>
            <X size={22} aria-hidden />
            Close suspects
          </button>
        </div>
        <p role={error ? "alert" : undefined}>
          {error ? "Suspects unavailable; check connection." : "Loading suspects…"}
        </p>
      </section>
    );
  return (
    <section className="station-card rc-suspects" aria-label="Suspect picker">
      <div className="rc-panel-head">
        <h3 className="rc-panel-title">
          <span className="rc-panel-icon" aria-hidden>
            <Search size={22} strokeWidth={2.6} />
          </span>
          <span className="rc-panel-kicker">SUSPECTS</span>
          <span className="st-sr"> · </span>
          <span className="rc-panel-sub">
            <span className="st-code">{center.intake_number}</span>{" "}
            {formatVariance(center.variance_pct)} (limit ±{center.limit_pct}%)
            {center.hold_id ? " · HELD" : ""}
          </span>
        </h3>
        <button type="button" className="st-btn-secondary" onClick={onClose}>
          <X size={22} aria-hidden />
          Close suspects
        </button>
      </div>
      {error && <p role="alert">Suspects unavailable; check connection.</p>}
      <ul className="rc-suspect-list" aria-label="Flagged order">
        {row(center, center.hold_id ? "Flagged:" : "Tapped:")}
      </ul>
      <h4>Most likely first</h4>
      <ol className="rc-suspect-list" aria-label="Suspects">
        {ranked.suspects.map((s) => row(byId.get(s.intakeId)!))}
      </ol>
      {ranked.unlikely.length > 0 && (
        <>
          <h4 className="rc-suspect-divider">{UNLIKELY_SOURCE}</h4>
          <ul className="rc-suspect-list rc-suspect-unlikely" aria-label={UNLIKELY_SOURCE}>
            {ranked.unlikely.map((s) => row(byId.get(s.intakeId)!))}
          </ul>
        </>
      )}
      {rows
        .filter((r) => r.position !== 0 && !grouped.has(r.intake_id))
        .map((r) => (
          <p key={r.intake_id} className="rc-suspect-other">
            {suspectLine(r)}
          </p>
        ))}
      <h4>Suggested moves</h4>
      {waiting.length > 0 ? (
        <p>
          Suggestions appear once every order in the group is reconciled. Waiting on:{" "}
          {waiting.map((w) => `${w.intake_number} (${SUSPECT_STATUS_LABELS[w.status]})`).join(", ")}
        </p>
      ) : moves.length === 0 ? (
        <p>No basket move brings the group closer; check the baskets or get a manager sign-off.</p>
      ) : (
        <ul className="rc-moves" aria-label="Suggested moves">
          {moves.map((m) => {
            const moving = bins.find((b) => b.id === m.vesselId);
            const text = `Move ${moving ? movingLabel(moving) : "basket"} ${number(m.fromIntakeId)} → ${number(m.toIntakeId)} (off by ${m.beforeLb} lb → ${m.afterLb} lb)`;
            return (
              <li key={m.vesselId}>
                <span>{text}</span>
                {m.pullBack.length > 0 ? (
                  <button
                    type="button"
                    className="st-btn-secondary"
                    disabled={disabled}
                    onClick={() => startPullBack(m.pullBack[0]!)}
                  >
                    <Undo2 size={20} aria-hidden />
                    Pull back {number(m.pullBack[0]!)} first
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onMove(m.vesselId, m.toIntakeId, center.intake_id)}
                  >
                    <ArrowRight size={20} aria-hidden />
                    Move this basket
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <h4>Move a basket</h4>
      {atReconcile.length < 2 ? (
        <p>Moving a basket needs two orders at reconcile; pull one back from blast first.</p>
      ) : (
        <>
          {atReconcile.map((r) => (
            <fieldset key={r.intake_id} className="rc-move-from">
              <legend>{r.intake_number} baskets</legend>
              {bins
                .filter((b) => b.intake_id === r.intake_id)
                .map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    disabled={disabled}
                    aria-pressed={selectedBin === b.id}
                    onClick={() => setSelectedBin(selectedBin === b.id ? null : b.id)}
                  >
                    {binLabel(b)}
                  </button>
                ))}
            </fieldset>
          ))}
          {bin &&
            atReconcile
              .filter((r) => r.intake_id !== bin.intake_id)
              .map((r) => (
                <button
                  key={r.intake_id}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onMove(bin.id, r.intake_id, center.intake_id);
                    setSelectedBin(null);
                  }}
                >
                  <ArrowRight size={20} aria-hidden />
                  Move {movingLabel(bin)} to {r.intake_number}
                </button>
              ))}
        </>
      )}
      {pullBackRow && (
        <fieldset className="rc-pullback" aria-label="Pull back from blast">
          <legend>Pull {pullBackRow.intake_number} back from blast to reconcile</legend>
          {editingReason ? (
            <>
              <label>
                Pull back reason (required)
                <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <button type="button" onClick={() => onEditReason(false)}>
                Done
              </button>
            </>
          ) : (
            <>
              {reason.trim() && <p>Reason: {reason}</p>}
              <button type="button" disabled={disabled} onClick={() => onEditReason(true)}>
                {reason.trim() ? "Edit reason" : "Add reason"}
              </button>
            </>
          )}
          <button
            type="button"
            disabled={disabled || editingReason || problem !== null}
            onClick={() => onPullBack(pullBackRow.intake_id, reason)}
          >
            Confirm pull back
          </button>
          <DisabledReason reason={!reason.trim() && "Add a reason first"} />
          <button
            type="button"
            className="st-btn-secondary"
            onClick={() => {
              onEditReason(false);
              setPullBackFor(null);
            }}
          >
            Cancel pull back
          </button>
          {reason.trim() && problem && <p role="alert">{problem}</p>}
        </fieldset>
      )}
    </section>
  );
}
