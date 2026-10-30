import { Check } from "lucide-react";

/**
 * The floor prompt (docs/11-FLOOR-WORDING.md, #98): the next step line (imperative verb +
 * object, the largest text on screen) and, on multi-step stations, the step row. Steps before
 * the current one show a check; the line fades up when it changes so the eye catches the new
 * instruction without the layout moving (two lines are reserved on tablets).
 */
export function NextStep({
  next,
  steps,
  step,
  tone,
}: {
  next: string;
  steps?: readonly string[];
  /** Index into `steps` of the current step. */
  step?: number;
  /** "warn" when the line is a warning (over the limit, held). */
  tone?: "warn";
}) {
  return (
    <div className="station-next-area">
      {steps && steps.length > 1 && (
        <ol className="station-steps" aria-label="Steps">
          {steps.map((label, n) => (
            <li
              key={label}
              aria-current={n === step ? "step" : undefined}
              data-state={step !== undefined && n < step ? "done" : undefined}
            >
              <span className="st-step-num">
                {step !== undefined && n < step ? (
                  <>
                    <Check size={18} strokeWidth={3.5} aria-hidden />
                    <span className="st-sr">{n + 1}</span>
                  </>
                ) : (
                  n + 1
                )}
              </span>{" "}
              <span className="st-step-label">{label}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="station-next" data-testid="next-step" data-tone={tone}>
        <span key={next} className="st-next-anim">
          {next}
        </span>
      </p>
    </div>
  );
}

/** Helper text under a disabled button saying why (not a tooltip). Renders nothing when enabled. */
export function DisabledReason({ reason }: { reason: string | null | undefined | false }) {
  return reason ? <p className="station-why">{reason}</p> : null;
}
