import { Check, LoaderCircle, Repeat2, Scale, Tag } from "lucide-react";

/**
 * A basket as a tap target: "Basket 042 · 9 lb" (the tag code in mono, as printed), its state
 * at the right edge (a scale to weigh, a check when weighed, a spinner while a weight saves) and
 * MANUAL WEIGHT when typed. Selected = the basket Accept / Enter weight write to: a teal frame
 * and "Weigh now" / "Selected", plus aria-pressed. The weight flashes once when it lands.
 */
export function BasketTile({
  code,
  exchange,
  weightLb,
  manual,
  savingLb,
  selected,
  disabled,
  onSelect,
}: {
  /** The tag code (null for an exchange basket). */
  code: string | null;
  exchange: boolean;
  weightLb: number;
  manual: boolean;
  /** A weight on its way to the server: shown at once, confirmed by the refresh. */
  savingLb?: number | null;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  const saving = savingLb !== null && savingLb !== undefined;
  const lb = saving ? savingLb : weightLb;
  const weighed = lb > 0;
  const state = saving ? "saving" : weighed ? "weighed" : "unweighed";
  return (
    <button
      type="button"
      className="st-basket"
      data-state={state}
      disabled={disabled}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="st-basket-icon" aria-hidden>
        {exchange || !code ? <Repeat2 size={22} /> : <Tag size={22} />}
      </span>
      <span className="st-basket-name">
        {exchange || !code ? (
          "Exchange basket"
        ) : (
          <>
            Basket <span className="st-code">{code}</span>
          </>
        )}
      </span>
      <span className="st-sr"> · </span>
      <span key={lb} className="st-basket-weight st-num">
        {weighed ? `${lb} lb` : "not weighed"}
      </span>
      {manual && (
        <>
          {" "}
          <span className="station-badge st-badge-manual">MANUAL WEIGHT</span>
        </>
      )}
      <span className="st-basket-state" aria-hidden>
        {selected && <span className="st-basket-flag">{weighed ? "Selected" : "Weigh now"}</span>}
        {saving ? (
          <LoaderCircle className="st-spin" size={24} />
        ) : weighed ? (
          <Check size={24} strokeWidth={3} />
        ) : (
          <Scale size={24} />
        )}
      </span>
    </button>
  );
}
