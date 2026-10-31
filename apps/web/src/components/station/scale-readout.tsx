import { Scale } from "lucide-react";

/**
 * stable: a stable reading ready to accept · used: the stable reading already written to a
 * basket (put the next one on) · none: no reading, the scale is off, unlinked or not assigned.
 */
export type ScaleState = "stable" | "used" | "none";

const STATE_TEXT: Record<ScaleState, string> = {
  stable: "Stable reading",
  used: "Reading used",
  none: "No reading / scale not assigned",
};

/**
 * The scale display: the latest stable reading in large tabular figures, like the scale's own
 * head, with its state in words and the basket Accept will write it to.
 */
export function ScaleReadout({
  reading,
  state,
  target,
}: {
  reading: number | null;
  state: ScaleState;
  /** "Basket 042": where Accept writes the reading. */
  target?: string | null;
}) {
  const shown = state === "none" || reading === null ? null : reading;
  return (
    <div className="st-scale" data-state={state}>
      <p className="st-scale-head">
        <Scale size={22} aria-hidden />
        <span>Scale</span>
        <span className="st-scale-state">{STATE_TEXT[state]}</span>
      </p>
      <p className="st-scale-value st-num" aria-label={shown === null ? "No reading" : undefined}>
        {shown === null ? "––.––" : shown.toFixed(2)}
        <span className="st-scale-unit">lb</span>
      </p>
      {target && (
        <p className="st-scale-target">
          Accept writes to <strong>{target}</strong>
        </p>
      )}
    </div>
  );
}
