"use client";
import { useState } from "react";
import { Check, Lock, Search, ShieldCheck } from "lucide-react";
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
import { StationButton } from "@/src/components/station/station-button";
import { SectionTitle, StationCard, StationNotice } from "@/src/components/station/station-ui";
import { BAND_ICON } from "@/src/components/station/variance-meter";

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
    <StationCard held aria-label="Variance hold">
      <div className="station-card-head">
        <div>
          <span className="station-card-eyebrow">
            <Lock aria-hidden="true" className="inline-block size-5 align-[-3px]" /> Held with its
            rollstock neighbours
          </span>
          <h3 className="station-hold-title">
            VARIANCE HOLD · {flagged?.intake_number} {formatVariance(flagged?.variance_pct ?? null)}{" "}
            (limit ±{flagged?.limit_pct}%)
          </h3>
        </div>
      </div>
      <p className="station-hint">
        {open?.position === 0
          ? "Send to Blast is refused until the baskets are fixed or a manager signs off."
          : `${open?.intake_number ?? "This order"} is a rollstock neighbour and waits for the hold to clear.`}
      </p>
      <SectionTitle>Hold group · rollstock order</SectionTitle>
      <ul className="station-rows">
        {group.map((m) => {
          const band = lineBand(m.band);
          const Icon = BAND_ICON[band];
          return (
            <li key={m.intake_id} className={`station-band station-band-${band}`}>
              <Icon aria-hidden="true" />
              <span className="station-band-text">
                <strong>{m.intake_number}</strong> · {formatVariance(m.variance_pct)} ·{" "}
                {BAND_LABEL[band]} · {memberState(m.state)}
              </span>
            </li>
          );
        })}
      </ul>
      {onFindSuspects && (
        <div className="station-section">
          <StationButton icon={<Search />} disabled={disabled} onClick={onFindSuspects}>
            Find the fish (suspects)
          </StationButton>
        </div>
      )}
      <div className="station-section">
        <fieldset className="station-pills">
          <legend>Manager sign-off reason</legend>
          {VARIANCE_SIGNOFF_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={reason === r}
              disabled={disabled}
              onClick={() => setReason(r)}
            >
              {VARIANCE_SIGNOFF_REASON_LABELS[r]}
            </button>
          ))}
        </fieldset>
        {editingNote ? (
          <div className="station-inline-form">
            <label className="station-field">
              Sign-off note{reason === "other" ? " (required)" : ""}
              <input
                autoFocus
                value={note}
                maxLength={SIGNOFF_NOTE_MAX}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <div className="station-actions">
              <StationButton tone="primary" icon={<Check />} onClick={() => onEditNote(false)}>
                Done
              </StationButton>
            </div>
          </div>
        ) : (
          <div className="station-note">
            {note.trim() ? <p>Note: {note}</p> : <p className="station-meta">No note yet</p>}
            <StationButton tone="ghost" disabled={disabled} onClick={() => onEditNote(true)}>
              {note.trim() ? "Edit note" : "Add note"}
              {reason === "other" ? " (required)" : ""}
            </StationButton>
          </div>
        )}
        <StationButton
          tone="primary"
          size="lg"
          icon={<ShieldCheck />}
          disabled={disabled || editingNote || problem !== null}
          why={reason === null && "Tap a reason first"}
          onClick={() => reason && onSignOff(reason, note)}
        >
          Manager sign-off
        </StationButton>
        {problem && (
          <StationNotice tone="danger" role="alert" className="mt-3">
            {problem}
          </StationNotice>
        )}
      </div>
    </StationCard>
  );
}
