import { Check } from "lucide-react";

/**
 * A count toward a total, "3 / 5 totes": a large tabular figure, what is left in words, and a
 * bar that fills as items tick off (it reads without colour: the figure and the words say the
 * same). At parity the bar turns green and a check leads the figure. Wave (totes scanned);
 * Rollstock and Boxing count the same way.
 */
export function CountProgress({
  done,
  total,
  noun,
  label,
}: {
  done: number;
  total: number;
  /** Plural noun after the figure: "totes". */
  noun: string;
  /** What is left, in words: "2 to scan", "Every tote scanned". */
  label?: string;
}) {
  const complete = total > 0 && done >= total;
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  return (
    <div className="st-progress" data-complete={complete || undefined}>
      <p className="st-progress-figure">
        {complete && <Check size={34} strokeWidth={3.2} aria-hidden />}
        <span className="st-num">{`${done} / ${total} ${noun}`}</span>
      </p>
      {label && <p className="st-progress-label">{label}</p>}
      <div className="st-progress-track" aria-hidden>
        <span className="st-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
