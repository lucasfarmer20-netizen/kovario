"use client";
import { useEffect, useState, type ReactNode } from "react";
import type { ManualOptions, ParseResult } from "rules";
import { ManualEntry, type EntryMethod } from "./manual-entry";
import { NextStep } from "./next-step";
import { StationsLink } from "./stations-link";
import { ScanInput } from "./scan-input";
export function StationShell({
  name,
  className = "",
  site,
  operator,
  pending,
  onScan,
  paused,
  manual,
  manualLabel,
  hideManual = false,
  next,
  steps,
  step,
  status,
  children,
}: {
  name: string;
  className?: string;
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
  /**
   * The station renders its own "Enter manually" where the operator is looking (Reconcile's
   * order card, #97), so the shell leaves it out rather than showing two.
   */
  hideManual?: boolean;
  /** The next step line (docs/11-FLOOR-WORDING.md): what the operator does now. */
  next: string;
  /** The station's steps, in order, with `step` the current one (multi-step stations). */
  steps?: readonly string[];
  step?: number;
  status: ReactNode;
  children: ReactNode;
}) {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  const [open, setOpen] = useState(false);
  // A hidden field is closed: the scanner must not stay paused behind it, nor the field reopen
  // (and take focus) when it shows again.
  const [wasHidden, setWasHidden] = useState(hideManual);
  if (wasHidden !== hideManual) {
    setWasHidden(hideManual);
    if (hideManual) setOpen(false);
  }
  const typing = open && !hideManual;
  return (
    <main className={`station ${className}`}>
      <header>
        <div>
          <p className="station-eyebrow">Filletry · {site}</p>
          <h1>{name}</h1>
        </div>
        <div className="station-chips">
          <StationsLink />
          <span className="station-badge">{operator ?? "Identify operator"}</span>
          <span className="station-badge" role="status">
            {offline ? "Offline · " : ""}
            {pending} pending
          </span>
        </div>
      </header>
      <NextStep next={next} steps={steps} step={step} />
      {!hideManual && (
        <ManualEntry
          open={typing}
          onOpenChange={setOpen}
          disabled={paused}
          options={manual}
          label={manualLabel}
          onSubmit={(text, parsed) => onScan(text, parsed, "manual")}
        />
      )}
      {status}
      <ScanInput onScan={(raw, parsed) => onScan(raw, parsed, "scan")} paused={paused || typing} />
      {children}
    </main>
  );
}
