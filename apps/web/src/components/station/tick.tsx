import type { ReactNode } from "react";
import { Check } from "lucide-react";

/**
 * A yes/no choice on a station form (Dirty fish, Fast Pass) or, with `row`, a whole-row tick in
 * a list (Storage pickup: each box going home). A real checkbox under a 56 px label (72 px as a
 * row): the whole label is the target, and ticked reads by fill, a check and a frame, not by
 * colour alone. `label` names the checkbox when the visible text is not enough ("Pick up Box 1").
 */
export function Tick({
  checked,
  onChange,
  disabled,
  label,
  row = false,
  meta,
  end,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** The checkbox's accessible name, when the visible text is not enough. */
  label?: string;
  /** A whole-row tick in a list, ≥ 72 px. */
  row?: boolean;
  /** With `row`: a line under the name ("20 lb · 3 days"). */
  meta?: ReactNode;
  /** With `row`: the right edge (a status). */
  end?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className={row ? "st-toggle st-toggle-row" : "st-toggle"}>
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="st-toggle-box" aria-hidden>
        <Check size={22} strokeWidth={3.4} />
      </span>
      {row ? (
        <>
          <span className="st-toggle-main">
            <span>{children}</span>
            {meta && <span className="st-toggle-meta">{meta}</span>}
          </span>
          {end && <span className="st-toggle-end">{end}</span>}
        </>
      ) : (
        <span>{children}</span>
      )}
    </label>
  );
}
