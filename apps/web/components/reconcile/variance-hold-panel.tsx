"use client";
import { useState } from "react";
import { Check, Lock, PenLine, Search, ShieldCheck } from "lucide-react";
import {
  formatVariance,
  SIGNOFF_NOTE_MAX,
  VARIANCE_SIGNOFF_REASON_LABELS,
  VARIANCE_SIGNOFF_REASONS,
  varianceSignoffProblem,
  type VarianceSignoffReason,
} from "rules";
import { BAND_LABEL, lineBand } from "@/components/variance/now-in-blast";
import type { HoldMember } from "@/components/variance/use-variance-holds";
import { DisabledReason } from "@/src/components/station/next-step";

/** Where a group member is, in the floor's words. */
export function memberState(state: HoldMember["state"]): string {
  switch (state) {
    case "reconcile":
      return "waiting at reconcile";
    case "blast_freezer":
      return "in blast";
    case "stored":
    case "done":
      return "sent to blast";
    case "cancelled":
      return "cancelled";
    default:
      return "not yet at reconcile";
  }
}

/**
 * A variance hold covering the open intake (#87): the group in rollstock order with each
 * member's variance, and the manager sign-off (reason + note). Wet-glove: plain buttons, no
 * focus trap; the PIN overlay is the caller's. The note is typed in an explicit editing mode
 * (`editingNote`): the caller pauses the station scanner while it is open, as for manual weight,
 * so the scanner's focus capture cannot pull focus out of the field; Done hands focus back.
 */
export function VarianceHoldPanel({
  group,
  openIntakeId,
  disabled,
  editingNote,
  onEditNote,
  onSignOff,
  onFindSuspects,
}: {
  group: readonly HoldMember[];
  openIntakeId: string;
  disabled: boolean;
  editingNote: boolean;
  onEditNote: (open: boolean) => void;
  onSignOff: (reason: VarianceSignoffReason, note: string) => void;
  /** Opens the suspect picker (#88) on this hold. */
  onFindSuspects?: () => void;
}) {
  const [reason, setReason] = useState<VarianceSignoffReason | null>(null);
  const [note, setNote] = useState("");
  const flagged = group.find((m) => m.position === 0);
  const open = group.find((m) => m.intake_id === openIntakeId);
  const problem = reason ? varianceSignoffProblem(reason, note) : null;
  return (
    <section className="station-card rc-hold" aria-label="Variance hold">
      <h3 className="rc-panel-title">
        <span className="rc-panel-icon" aria-hidden>
          <Lock size={22} strokeWidth={2.6} />
        </span>
        <span className="rc-panel-kicker">VARIANCE HOLD</span>
        <span className="st-sr"> · </span>
        <span className="rc-panel-sub">
          <span className="st-code">{flagged?.intake_number}</span>{" "}
          {formatVariance(flagged?.variance_pct ?? null)} (limit ±{flagged?.limit_pct}%)
        </span>
      </h3>
      <p className="rc-panel-lead">
        {open?.position === 0
          ? "Send to Blast is refused until the baskets are fixed or a manager signs off."
          : `${open?.intake_number ?? "This order"} is a rollstock neighbour and waits for the hold to clear.`}
      </p>
      <ul className="rc-group">
        {group.map((m) => {
          const band = lineBand(m.band);
          return (
            <li
              key={m.intake_id}
              className={`station-band station-band-${band}`}
              data-current={m.intake_id === openIntakeId || undefined}
            >
              <span className="st-code rc-group-number">{m.intake_number}</span>
              <span className="st-sr"> · </span>
              <span className="st-num rc-group-variance">{formatVariance(m.variance_pct)}</span>
              <span className="st-sr"> · </span>
              <span className="rc-group-band">{BAND_LABEL[band]}</span>
              <span className="st-sr"> · </span>
              <span className="rc-group-state">{memberState(m.state)}</span>
            </li>
          );
        })}
      </ul>
      {onFindSuspects && (
        <button
          type="button"
          className="st-btn-secondary st-btn-block"
          disabled={disabled}
          onClick={onFindSuspects}
        >
          <Search size={22} aria-hidden />
          Find the fish (suspects)
        </button>
      )}
      <fieldset className="rc-reasons">
        <legend>Manager sign-off reason</legend>
        {VARIANCE_SIGNOFF_REASONS.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={reason === r}
            disabled={disabled}
            onClick={() => setReason(r)}
          >
            {reason === r && <Check size={20} strokeWidth={3} aria-hidden />}
            {VARIANCE_SIGNOFF_REASON_LABELS[r]}
          </button>
        ))}
      </fieldset>
      {editingNote ? (
        <div className="rc-note">
          <label>
            Sign-off note{reason === "other" ? " (required)" : ""}
            <input
              autoFocus
              value={note}
              maxLength={SIGNOFF_NOTE_MAX}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <button type="button" onClick={() => onEditNote(false)}>
            Done
          </button>
        </div>
      ) : (
        <div className="rc-note">
          {note.trim() && <p className="rc-note-text">Note: {note}</p>}
          <button
            type="button"
            className="st-btn-secondary"
            disabled={disabled}
            onClick={() => onEditNote(true)}
          >
            <PenLine size={20} aria-hidden />
            {note.trim() ? "Edit note" : "Add note"}
            {reason === "other" ? " (required)" : ""}
          </button>
        </div>
      )}
      <button
        type="button"
        className="st-btn-hero st-btn-block rc-signoff"
        disabled={disabled || editingNote || reason === null || problem !== null}
        onClick={() => reason && onSignOff(reason, note)}
      >
        <ShieldCheck size={26} aria-hidden />
        Manager sign-off
      </button>
      <DisabledReason reason={reason === null && "Tap a reason first"} />
      {problem && (
        <p role="alert" className="rc-problem">
          {problem}
        </p>
      )}
    </section>
  );
}
