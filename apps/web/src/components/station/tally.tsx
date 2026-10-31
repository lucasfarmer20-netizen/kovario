import { Check } from "lucide-react";

/** Up to this many items show one pip each; more show one bar. */
export const TALLY_PIPS = 12;

/**
 * How many of a known set are done (Rollstock: totes scanned of the order's totes; Wave next):
 * one pip per item, done ones filled with a check, or one bar past {@link TALLY_PIPS}. The words
 * beside it say the same ("tote 1 of 2"); `label` names it for screen readers.
 */
export function Tally({ done, total, label }: { done: number; total: number; label: string }) {
  const count = Math.max(0, Math.min(done, total));
  return (
    <div
      className="st-tally"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={count}
      data-complete={total > 0 && count === total ? "" : undefined}
    >
      {total <= TALLY_PIPS ? (
        Array.from({ length: total }, (_, n) => (
          <span key={n} className="st-tally-pip" data-done={n < count ? "" : undefined}>
            {n < count && <Check size={16} strokeWidth={3.5} aria-hidden />}
          </span>
        ))
      ) : (
        <span className="st-tally-bar">
          <span style={{ width: `${total ? (count / total) * 100 : 0}%` }} />
        </span>
      )}
    </div>
  );
}
