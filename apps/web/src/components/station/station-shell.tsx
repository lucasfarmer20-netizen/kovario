"use client";
import { useState, type ReactNode } from "react";
import { Fish, UserRound } from "lucide-react";
import type { ManualOptions, ParseResult } from "rules";
import { ConnectionChip, useOnline } from "./connection-chip";
import { ManualEntry, type EntryMethod } from "./manual-entry";
import { NextStep } from "./next-step";
import { StationsLink } from "./stations-link";
import { ScanInput } from "./scan-input";
import { ScannerPaused } from "./scanner-context";
export function StationShell({
  name,
  site,
  operator,
  pending,
  onScan,
  paused,
  manual,
  manualLabel,
  hideManual = false,
  next,
  nextTone,
  steps,
  step,
  status,
  online: onlineOverride,
  defaultManualOpen = false,
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
  /**
   * The station renders its own "Enter manually" where the operator is looking (Reconcile's
   * order card, #97), so the shell leaves it out rather than showing two.
   */
  hideManual?: boolean;
  /** The next step line (docs/11-FLOOR-WORDING.md): what the operator does now. */
  next: string;
  /** "warn" when the next step line is a warning. */
  nextTone?: "warn";
  /** The station's steps, in order, with `step` the current one (multi-step stations). */
  steps?: readonly string[];
  step?: number;
  /** The scan tile and replies: beside the next step line on a tablet, under it on a phone. */
  status: ReactNode;
  /** Overrides navigator.onLine (previews in the station gallery). */
  online?: boolean;
  /** "Enter manually" starts open (previews in the station gallery). */
  defaultManualOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultManualOpen);
  const online = useOnline() && onlineOverride !== false;
  // A hidden field is closed: the scanner must not stay paused behind it, nor the field reopen
  // (and take focus) when it shows again.
  const [wasHidden, setWasHidden] = useState(hideManual);
  if (wasHidden !== hideManual) {
    setWasHidden(hideManual);
    if (hideManual) setOpen(false);
  }
  const typing = open && !hideManual;
  return (
    <main className="station">
      <ScannerPaused value={Boolean(paused) || typing}>
        <header className="station-topbar">
          <div className="st-brandline">
            <span className="st-mark" aria-hidden>
              <Fish size={26} strokeWidth={2.2} />
            </span>
            <div>
              <p className="station-eyebrow">Filletry · {site}</p>
              <h1>{name}</h1>
            </div>
          </div>
          <div className="station-chips">
            <ConnectionChip pending={pending} online={online} />
            <span className="station-badge" data-tone={operator ? undefined : "identify"}>
              <UserRound size={20} aria-hidden />
              {operator ?? "Identify operator"}
            </span>
            <StationsLink />
          </div>
        </header>
        <div className="station-command">
          <div className="station-command-main">
            <NextStep next={next} steps={steps} step={step} tone={nextTone} />
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
          </div>
          <div className="station-command-status">{status}</div>
        </div>
        <ScanInput
          onScan={(raw, parsed) => onScan(raw, parsed, "scan")}
          paused={paused || typing}
        />
        {children}
      </ScannerPaused>
    </main>
  );
}
