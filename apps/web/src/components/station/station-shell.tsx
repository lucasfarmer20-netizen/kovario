"use client";
import type { ReactNode } from "react";
import type { ParseResult } from "rules";
import { StationsLink } from "./stations-link";
import { ScanInput } from "./scan-input";
export function StationShell({
  name,
  site,
  operator,
  pending,
  onScan,
  paused,
  status,
  children,
}: {
  name: string;
  site: string;
  operator: string | null;
  pending: number;
  onScan: (raw: string, parsed: ParseResult) => void;
  paused?: boolean;
  status: ReactNode;
  children: ReactNode;
}) {
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
      {status}
      <ScanInput onScan={onScan} paused={paused} />
      {children}
    </main>
  );
}
