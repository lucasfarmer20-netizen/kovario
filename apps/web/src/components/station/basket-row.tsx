import { Fragment, type ReactNode } from "react";
import { Check, LoaderCircle, Repeat2, Tag } from "lucide-react";

/**
 * A basket in a list (Blast, Locate; next Boxing): its name ("Basket 042", the tag code in mono,
 * as printed, or "Exchange basket"), a meta line ("INT-0002 · 12 lb · 0h 05m") and, at the right
 * edge, what happens to it: a hint, a status or one action (`end`). As a whole-row tap target
 * (`onSelect`) it is a toggle: selected shows a teal frame, "Selected" and `aria-pressed`.
 * `busy` puts a spinner at the right edge while a tap on it is on its way to the server. Text
 * reads in one line for screen readers: "Basket 042 · INT-0002 · 12 lb · Blast in".
 */
export function BasketRow({
  code,
  meta,
  end,
  selected,
  busy,
  disabled,
  label,
  onSelect,
}: {
  /** The tag code; null for an exchange basket. */
  code: string | null;
  /** Order number, weight, time: shown in one line, separated by " · ". */
  meta: readonly ReactNode[];
  /** The right edge: a hint ("Scan"), a status ("2h 05m") or one button (not with `onSelect`). */
  end?: ReactNode;
  /** With `onSelect`: this row is the current choice. */
  selected?: boolean;
  /** A tap on this row is being sent: a spinner replaces the right edge. */
  busy?: boolean;
  disabled?: boolean;
  /** With `onSelect`: the button's accessible name, when the row text is not enough. */
  label?: string;
  /** Makes the whole row one tap target (≥ 72 px). */
  onSelect?: () => void;
}) {
  const body = (
    <>
      <span className="st-basket-icon" aria-hidden>
        {code === null ? <Repeat2 size={22} /> : <Tag size={22} />}
      </span>
      <span className="st-basket-row-main">
        <span className="st-basket-name">
          {code === null ? (
            "Exchange basket"
          ) : (
            <>
              Basket <span className="st-code">{code}</span>
            </>
          )}
        </span>
        {meta.length > 0 && (
          <>
            <span className="st-sr"> · </span>
            <span className="st-basket-row-meta">
              {meta.map((part, n) => (
                <Fragment key={n}>
                  {n > 0 && " · "}
                  <span className="st-basket-row-part">{part}</span>
                </Fragment>
              ))}
            </span>
          </>
        )}
      </span>
      {(end || busy || selected) && (
        <>
          <span className="st-sr"> · </span>
          <span className="st-basket-row-end">
            {busy ? (
              <LoaderCircle className="st-spin" size={24} aria-hidden />
            ) : selected ? (
              <span className="st-basket-flag">
                <Check size={16} strokeWidth={3.5} aria-hidden /> Selected
              </span>
            ) : (
              end
            )}
          </span>
        </>
      )}
    </>
  );
  if (onSelect)
    return (
      <button
        type="button"
        className="st-basket-row"
        data-busy={busy || undefined}
        aria-pressed={Boolean(selected)}
        aria-label={label}
        disabled={disabled}
        onClick={onSelect}
      >
        {body}
      </button>
    );
  return (
    <div className="st-basket-row" data-busy={busy || undefined}>
      {body}
    </div>
  );
}
