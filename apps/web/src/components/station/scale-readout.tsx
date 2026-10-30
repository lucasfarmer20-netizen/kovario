"use client";
import { CloudOff, Scale } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * What the station's scale is doing. `stale` is a stable reading the operator already accepted
 * for the previous basket (reconcile auto-advances to the next one): shown, but not accepted
 * again until the scale settles on a new reading.
 */
export type ScaleState =
  | { kind: "none" }
  | { kind: "waiting" }
  | { kind: "stable"; weightLb: number }
  | { kind: "stale"; weightLb: number };

export function scaleLabel(state: ScaleState): string {
  switch (state.kind) {
    case "none":
      return "No scale on this station";
    case "waiting":
      return "Scale · no stable reading";
    case "stable":
      return "Scale · stable";
    case "stale":
      return "Scale · reading already used";
  }
}

/** The latest stable weight, large, with the scale's state in words and a colour. */
export function ScaleReadout({ state, className }: { state: ScaleState; className?: string }) {
  const live = state.kind === "stable";
  const off = state.kind === "none" || state.kind === "waiting";
  const value = off ? "—" : `${state.weightLb.toFixed(2)}`;
  return (
    <div
      className={cn(
        "station-scale",
        live && "station-scale-live",
        off && "station-scale-off",
        className,
      )}
    >
      <span className="station-scale-icon" aria-hidden="true">
        {state.kind === "none" ? <CloudOff /> : <Scale />}
      </span>
      <span className="station-scale-label">
        <span className="station-scale-dot" aria-hidden="true" />
        {scaleLabel(state)}
      </span>
      <span className="station-scale-value st-num">
        {value}
        {!off && <small>lb</small>}
      </span>
    </div>
  );
}
