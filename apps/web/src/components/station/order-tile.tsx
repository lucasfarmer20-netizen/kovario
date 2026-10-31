import { useId } from "react";
import { Clock, Lock } from "lucide-react";

/**
 * An order in a station queue: the order number (mono, as on the tote), HELD when a variance
 * hold blocks it, a one-line summary and how long it has waited. Its accessible name is the
 * number (and HELD); the summary is its description. `current` marks the open order. Without
 * `onOpen` it is a static tile, for a queue the station only shows (Rollstock's NEXT UP).
 */
export function OrderTile({
  number,
  held = false,
  detail,
  age,
  current = false,
  disabled,
  onOpen,
}: {
  number: string;
  held?: boolean;
  detail?: string;
  /** "12m", "3h": time in this queue. */
  age?: string;
  current?: boolean;
  disabled?: boolean;
  /** Opens the order; without it the tile is not a button. */
  onOpen?: () => void;
}) {
  const id = useId();
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
      </span>
      {(detail || age) && (
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
      aria-label={held ? `${number} HELD` : number}
      aria-describedby={detail || age ? id : undefined}
      disabled={disabled}
      onClick={onOpen}
    >
      {body}
    </button>
  );
}
