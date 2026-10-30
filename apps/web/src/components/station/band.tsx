import type { ReactNode } from "react";
import { NEAR_LIMIT_DENOMINATOR, NEAR_LIMIT_NUMERATOR, type VarianceBand } from "rules";

/**
 * A variance band as a chip: tint + edge colour, a shape (circle-check within, triangle near,
 * octagon over, dashed circle no estimate) and the band in words, so it reads without colour.
 */
export function BandChip({ band, children }: { band: VarianceBand; children: ReactNode }) {
  return <span className={`station-band station-band-${band} st-band-chip`}>{children}</span>;
}

/**
 * The variance meter: a track from −2×limit to +2×limit with the within / near / over zones
 * (over is hatched, so the zones differ without colour) and a needle at the order's variance.
 * Decorative: the numbers and the band chip beside it say the same thing in words.
 */
export function VarianceMeter({
  variancePct,
  limitPct,
  band,
}: {
  variancePct: number | null;
  limitPct: number;
  band: VarianceBand;
}) {
  const range = Math.max(limitPct * 2, 10);
  const at = (pct: number) =>
    ((Math.max(-range, Math.min(range, pct)) + range) / (2 * range)) * 100;
  const near = (limitPct * NEAR_LIMIT_NUMERATOR) / NEAR_LIMIT_DENOMINATOR;
  const zones: Array<[VarianceBand, number, number]> = [
    ["over", 0, at(-limitPct)],
    ["near", at(-limitPct), at(-near)],
    ["within", at(-near), at(near)],
    ["near", at(near), at(limitPct)],
    ["over", at(limitPct), 100],
  ];
  const clipped = variancePct !== null && Math.abs(variancePct) > range;
  return (
    <div className="st-meter" aria-hidden data-band={band}>
      <div className="st-meter-track">
        {zones.map(([zone, from, to], n) => (
          <span
            key={n}
            className="st-meter-zone"
            data-band={zone}
            style={{ left: `${from}%`, width: `${to - from}%` }}
          />
        ))}
        {variancePct !== null && (
          <span
            className="st-meter-needle"
            data-clipped={clipped || undefined}
            style={{ left: `${at(variancePct)}%` }}
          />
        )}
      </div>
      <div className="st-meter-scale">
        <span style={{ left: `${at(-limitPct)}%` }}>−{limitPct}%</span>
        <span style={{ left: "50%" }}>0</span>
        <span style={{ left: `${at(limitPct)}%` }}>+{limitPct}%</span>
      </div>
    </div>
  );
}
