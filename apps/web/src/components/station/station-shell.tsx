"use client";
import { useState, type ReactNode } from "react";
import type { ManualOptions, ParseResult } from "rules";
import { ManualEntry, type EntryMethod } from "./manual-entry";
import { ScanInput } from "./scan-input";
export function StationShell({
  name,
  site,
  operator,
  pending,
  onScan,
  paused,
  manual,
  status,
  children,
}: {
  name: string;
  site: string;
  operator: string | null;
  pending: number;
  /** Hardware scans and typed codes alike; `method` is "manual" for "Type code". */
  onScan: (raw: string, parsed: ParseResult, method: EntryMethod) => void;
  paused?: boolean;
  /** Typed-code reading for this station (org slug, tag digits, accepted kinds). */
  manual?: ManualOptions;
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
          <span className="station-badge">{operator ?? "Identify operator"}</span>
          <span className="station-badge" role="status">
            {pending} pending
          </span>
        </div>
      </header>
      {status}
      <ScanInput onScan={(raw, parsed) => onScan(raw, parsed, "scan")} paused={paused || typing} />
      <ManualEntry
        open={typing}
        onOpenChange={setTyping}
        disabled={paused}
        options={manual}
        onSubmit={(text, parsed) => onScan(text, parsed, "manual")}
      />
      {children}
    </main>
  );
}
