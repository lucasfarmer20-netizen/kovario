/**
 * The floor prompt (docs/11-FLOOR-WORDING.md, #98): the next step line (imperative verb +
 * object, the largest text on screen) and, on multi-step stations, the step row.
 */
export function NextStep({
  next,
  steps,
  step,
}: {
  next: string;
  steps?: readonly string[];
  /** Index into `steps` of the current step. */
  step?: number;
}) {
  return (
    <div className="station-next-area">
      {steps && steps.length > 1 && (
        <ol className="station-steps" aria-label="Steps">
          {steps.map((label, n) => (
            <li key={label} aria-current={n === step ? "step" : undefined}>
              {n + 1} {label}
            </li>
          ))}
        </ol>
      )}
      <p className="station-next" data-testid="next-step">
        {next}
      </p>
    </div>
  );
}

/** Helper text under a disabled button saying why (not a tooltip). Renders nothing when enabled. */
export function DisabledReason({ reason }: { reason: string | null | undefined | false }) {
  return reason ? <p className="station-why">{reason}</p> : null;
}
