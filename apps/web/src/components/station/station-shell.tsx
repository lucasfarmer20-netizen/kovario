"use client";
import { useState, type ReactNode } from "react";
import type { ManualOptions, ParseResult } from "rules";
import { ManualEntry, type EntryMethod } from "./manual-entry";
import { NextStep } from "./next-step";
import { StationsLink } from "./stations-link";
import { ScanInput } from "./scan-input";
export function StationShell({
  name,
  site,
  operator,
  pending,
  onScan,
  paused,
  manual,
  manualLabel,
  next,
  steps,
  step,
  status,
  children,
}: {
  name: string;
  site: string;
  operator: string | null;
  pending: number;
  /** Hardware scans and typed codes alike; `method` is "manual" for "Enter manually". */
  onScan: (raw: string, parsed: ParseResult, method: EntryMethod) => void;
  paused?: boolean;
  /** Typed-code reading for this station (org slug, tag digits, accepted kinds). */
  manual?: ManualOptions;
  /** The "Enter manually" field's label: what is expected now, e.g. "Basket number". */
  manualLabel?: string;
  /** The next step line (docs/11-FLOOR-WORDING.md): what the operator does now. */
  next: string;
  /** The station's steps, in order, with `step` the current one (multi-step stations). */
  steps?: readonly string[];
  step?: number;
  status: ReactNode;
  children: ReactNode;
}) {
  const [typing, setTyping] = useState(false);
  return (
    <main className="station">
      <header>
        <div>
          <p className="station-eyebrow">Filletry · {site}</p>
          <h1>{name}</h1>
        </div>
        <div className="station-chips">
          <StationsLink />
          <span className="station-badge">{operator ?? "Identify operator"}</span>
          <span className="station-badge" role="status">
            {pending} pending
          </span>
        </div>
      </header>
      <NextStep next={next} steps={steps} step={step} />
      <ManualEntry
        open={typing}
        onOpenChange={setTyping}
        disabled={paused}
        options={manual}
        label={manualLabel}
        onSubmit={(text, parsed) => onScan(text, parsed, "manual")}
      />
      {status}
      <ScanInput onScan={(raw, parsed) => onScan(raw, parsed, "scan")} paused={paused || typing} />
      {children}
    </main>
  );
}
