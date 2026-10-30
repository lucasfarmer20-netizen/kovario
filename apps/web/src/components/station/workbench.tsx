import { Check, ArrowRight, Scale, ScanLine } from "lucide-react";
import { DisabledReason } from "./next-step";

export function BasketButton({
  name,
  weight,
  manual,
  selected,
  disabled,
  onClick,
}: {
  name: string;
  weight: number;
  manual?: boolean;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="station-basket"
      aria-label={`${name} · ${weight} lb${manual ? " MANUAL WEIGHT" : ""}`}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="station-basket-icon" aria-hidden="true">
        {weight > 0 ? <Check size={24} /> : <ScanLine size={24} />}
      </span>
      <span>
        <strong>{name}</strong>
        {manual && <span className="station-manual-mark">MANUAL WEIGHT</span>}
      </span>
      <span className="station-basket-weight">{weight > 0 ? `${weight} lb` : "Weigh"}</span>
    </button>
  );
}

export function ScaleReadout({
  reading,
  basket,
}: {
  reading: number | null;
  basket: string | null;
}) {
  return (
    <div className="station-scale-readout">
      <p className="station-scale-label">
        <Scale size={22} aria-hidden="true" /> Latest stable scale
      </p>
      <div className="station-scale-number">
        {reading === null ? "—" : reading.toFixed(2)} <span>lb</span>
      </div>
      <p>{reading === null ? "No reading / scale not assigned" : "Stable reading"}</p>
      <div className="station-scale-target">{basket ?? "No basket selected"}</div>
    </div>
  );
}

export function ActionStrip({
  summary,
  disabled,
  reason,
  onSend,
}: {
  summary: string;
  disabled: boolean;
  reason: string | null;
  onSend: () => void;
}) {
  return (
    <div className="station-action-strip">
      <div>
        <strong>{summary}</strong>
        <DisabledReason reason={reason} />
      </div>
      <button disabled={disabled} onClick={onSend}>
        Send to Blast Freezer <ArrowRight size={24} aria-hidden="true" />
      </button>
    </div>
  );
}
