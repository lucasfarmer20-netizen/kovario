import { useId } from "react";
import { Check, Clock, Lock, Plus } from "lucide-react";

/**
 * An order in a station queue: the order number (mono, as on the tote), HELD when a variance
 * hold blocks it, a one-line summary and how long it has waited. Its accessible name is the
 * number (and HELD); the summary is its description. `current` marks the open order.
 * `pressed` makes it a toggle (Wave: tap orders into the wave), shown by a frame, the word
 * "Added" with a check, and `aria-pressed`; `flags` are badges such as FAST PASS. Without
 * `onOpen` it is a static tile, for a queue the station only shows (Rollstock's NEXT UP).
 */
export function OrderTile({
  number,
  held = false,
  detail,
  age,
  current = false,
  pressed,
  flags,
  disabled,
  onOpen,
}: {
  number: string;
  held?: boolean;
  detail?: string;
  /** "12m", "3h": time in this queue. */
  age?: string;
  current?: boolean;
  /** A toggle tile: true when chosen. Leave undefined for a tile that opens an order. */
  pressed?: boolean;
  /** Badges after the summary: "FAST PASS", "DIRTY". */
  flags?: readonly string[];
  disabled?: boolean;
  /** Opens (or toggles) the order; without it the tile is not a button. */
  onOpen?: () => void;
}) {
  const id = useId();
  const hasMeta = Boolean(detail || age || flags?.length);
  const body = (
    <>
      <span className="st-order-top">
        <span className="st-code st-order-number">{number}</span>
        {held && (
          <span className="station-badge st-badge-hold">
            <Lock size={16} strokeWidth={2.6} aria-hidden />
            HELD
          </span>
        )}
        {pressed !== undefined && (
          <span className="st-order-pick" data-on={pressed || undefined}>
            {pressed ? (
              <>
                <Check size={18} strokeWidth={3.2} aria-hidden />
                Added
              </>
            ) : (
              <Plus size={20} strokeWidth={2.6} aria-hidden />
            )}
          </span>
        )}
      </span>
      {hasMeta && (
        <span className="st-order-meta" id={id}>
          <span className="st-sr"> · </span>
          {detail && <span className="st-order-detail">{detail}</span>}
          {age && (
            <span className="st-order-age">
              <span className="st-sr"> · </span>
              <Clock size={16} aria-hidden />
              {age}
            </span>
          )}
          {flags && flags.length > 0 && (
            <span className="st-order-flags">
              {flags.map((flag) => (
                <span key={flag} className="station-badge st-badge-flag">
                  {flag}
                </span>
              ))}
            </span>
          )}
        </span>
      )}
    </>
  );
  if (!onOpen)
    return (
      <div className="st-order" data-held={held || undefined}>
        {body}
      </div>
    );
  return (
    <button
      type="button"
      className="st-order"
      data-held={held || undefined}
      aria-current={current || undefined}
      aria-pressed={pressed}
      aria-label={held ? `${number} HELD` : number}
      aria-describedby={hasMeta ? id : undefined}
      disabled={disabled}
      onClick={onOpen}
    >
      {body}
    </button>
  );
}
