"use client";
import type { ElementType, ReactNode } from "react";
import { CircleCheck, CircleDot, OctagonX, TriangleAlert } from "lucide-react";
import { formatVariance, type VarianceBand } from "rules";
import { BAND_LABEL } from "@/components/variance/now-in-blast";
import { cn } from "@/lib/utils";

/** Each band has its own shape as well as its colour (#87: never colour alone). */
export const BAND_ICON: Record<VarianceBand, ElementType> = {
  within: CircleCheck,
  near: TriangleAlert,
  over: OctagonX,
  unknown: CircleDot,
};

/**
 * The band chip: "within limit (limit ±15%)" in the band's colour with its icon. `children`
 * adds a note after the words (e.g. what a send over the limit will do).
 */
export function BandChip({
  band,
  limit,
  as: Tag = "p",
  className,
  children,
}: {
  band: VarianceBand;
  limit: number;
  as?: "p" | "span" | "li";
  className?: string;
  children?: ReactNode;
}) {
  const Icon = BAND_ICON[band];
  return (
    <Tag className={cn("station-band", `station-band-${band}`, className)}>
      <Icon aria-hidden="true" />
      {BAND_LABEL[band]} (limit ±{limit}%)
      {children}
    </Tag>
  );
}

function Figure({
  label,
  value,
  unit,
  hero = false,
}: {
  label: string;
  value: string;
  unit?: string;
  hero?: boolean;
}) {
  return (
    <div className={cn("station-figure", hero && "station-figure-hero")}>
      <span className="station-figure-label">{label}</span>
      <span className="station-figure-value">
        {value}
        {unit && <small>{unit}</small>}
      </span>
    </div>
  );
}

/**
 * Actual, expected and the variance as figures; a meter with the zero line, the within-limit
 * zone and a mark; then the band chip. The meter spans ±2× the limit, so the mark sits inside
 * the striped zone while the order is within the limit and outside it when it is over.
 */
export function VarianceMeter({
  actual,
  expected,
  variance,
  band,
  limit,
  note,
  children,
}: {
  actual: number;
  expected: number;
  variance: number | null;
  band: VarianceBand;
  limit: number;
  /** A note inside the band chip, after the words. */
  note?: ReactNode;
  children?: ReactNode;
}) {
  const span = limit * 2;
  const clamped = variance === null ? 0 : Math.max(-span, Math.min(span, variance));
  const mark = 50 + (clamped / span) * 50;
  const zoneLeft = 50 - (limit / span) * 50;
  const zoneWidth = (limit / span) * 100;
  return (
    <div className="station-variance">
      <div className="station-variance-figures">
        <Figure label="Actual" value={actual.toFixed(2)} unit="lb" />
        <Figure label="Expected" value={expected.toFixed(2)} unit="lb" />
        <Figure label="Variance" value={formatVariance(variance)} hero />
      </div>
      <div className="station-meter" aria-hidden="true">
        <div
          className="station-meter-limit"
          style={{ left: `${zoneLeft}%`, width: `${zoneWidth}%` }}
        />
        <div className="station-meter-zero" />
        <div className="station-meter-mark" style={{ left: `${mark}%` }} />
      </div>
      <div className="station-meter-scale" aria-hidden="true">
        <span>−{span}%</span>
        <span>−{limit}%</span>
        <span>0</span>
        <span>+{limit}%</span>
        <span>+{span}%</span>
      </div>
      <BandChip band={band} limit={limit}>
        {note}
      </BandChip>
      {children}
    </div>
  );
}
