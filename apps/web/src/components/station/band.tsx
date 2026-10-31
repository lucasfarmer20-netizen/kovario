import type { ReactNode } from "react";
import { NEAR_LIMIT_DENOMINATOR, NEAR_LIMIT_NUMERATOR, type VarianceBand } from "rules";

/**
 * A variance band as a chip: tint + edge colour, a shape (circle-check within, triangle near,
 * octagon over, dashed circle no estimate) and the band in words, so it reads without colour.
 */
export function BandChip({ band, children }: { band: VarianceBand; children: ReactNode }) {
  return <span className={`station-band station-band-${band} st-band-chip`}>{children}</span>;
}

/** The meter's full range, ± percent: every variance up to an order of twice its estimate. */
export const METER_RANGE_PCT = 100;

/** Where `pct` sits on the meter, 0–100 (% of its width); beyond ±100% it is pinned to the end. */
export function meterPosition(pct: number): number {
  const range = METER_RANGE_PCT;
  return ((Math.max(-range, Math.min(range, pct)) + range) / (2 * range)) * 100;
}

/**
 * The variance meter: a track over the full range, −100% to +100%, with the within / near / over
 * zones of the org's limit (near is striped and over is hatched, so the zones differ without
 * colour), the limit marked on the scale, a tick at 0 and a needle at the order's variance (red
 * when pinned past ±100%). Decorative: the numbers and the band chip beside it say the same
 * thing in words. `compact` drops the scale (a list of lines, each with its figure and band in
 * words): the zones still mark the limit.
 */
export function VarianceMeter({
  variancePct,
  limitPct,
  band,
  compact = false,
}: {
  variancePct: number | null;
  limitPct: number;
  band: VarianceBand;
  compact?: boolean;
}) {
  const at = meterPosition;
  const near = (limitPct * NEAR_LIMIT_NUMERATOR) / NEAR_LIMIT_DENOMINATOR;
  const zones: Array<[VarianceBand, number, number]> = [
    ["over", 0, at(-limitPct)],
    ["near", at(-limitPct), at(-near)],
    ["within", at(-near), at(near)],
    ["near", at(near), at(limitPct)],
    ["over", at(limitPct), 100],
  ];
  const clipped = variancePct !== null && Math.abs(variancePct) > METER_RANGE_PCT;
  return (
    <div className="st-meter" aria-hidden data-band={band} data-compact={compact || undefined}>
      <div className="st-meter-track">
        {zones.map(([zone, from, to], n) => (
          <span
            key={n}
            className="st-meter-zone"
            data-band={zone}
            style={{ left: `${from}%`, width: `${to - from}%` }}
          />
        ))}
        <span className="st-meter-zero" style={{ left: "50%" }} />
        {variancePct !== null && (
          <span
            className="st-meter-needle"
            data-clipped={clipped || undefined}
            style={{ left: `${at(variancePct)}%` }}
          />
        )}
      </div>
      {!compact && (
        <div className="st-meter-scale">
          <span data-edge="start" style={{ left: "0%" }}>
            −{METER_RANGE_PCT}%
          </span>
          <span style={{ left: `${at(-limitPct)}%` }}>−{limitPct}%</span>
          <span style={{ left: `${at(limitPct)}%` }}>+{limitPct}%</span>
          <span data-edge="end" style={{ left: "100%" }}>
            +{METER_RANGE_PCT}%
          </span>
        </div>
      )}
    </div>
  );
}
