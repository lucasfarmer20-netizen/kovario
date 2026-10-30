"use client";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { CloudOff, KeyRound, RefreshCw, UserRound, Check } from "lucide-react";
import type { ManualOptions, ParseResult } from "rules";
import { cn } from "@/lib/utils";
import { ManualEntry, type EntryMethod } from "./manual-entry";
import { NextStep } from "./next-step";
import { StationBadge } from "./station-ui";
import { StationsLink } from "./stations-link";
import { ScanInput } from "./scan-input";

function subscribeOnline(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

/** Whether the browser believes it is online; true during server rendering. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

/** The scan queue's state (docs/06): synced, N pending, or offline with N pending. */
export function SyncBadge({ pending, online }: { pending: number; online: boolean }) {
  const tone = !online ? "danger" : pending > 0 ? "warn" : "quiet";
  const icon = !online ? <CloudOff /> : pending > 0 ? <RefreshCw /> : <Check />;
  const text = !online
    ? `Offline · ${pending} pending`
    : pending > 0
      ? `${pending} pending`
      : "Synced";
  return (
    <StationBadge role="status" tone={tone} icon={icon} chip>
      {text}
    </StationBadge>
  );
}

export type StationFrameProps = {
  name: string;
  site: string;
  operator: string | null;
  pending: number;
  online?: boolean;
  /** The next step line (docs/11-FLOOR-WORDING.md): what the operator does now. */
  next: string;
  /** The station's steps, in order, with `step` the current one (multi-step stations). */
  steps?: readonly string[];
  step?: number;
  /** The "Enter manually" control, under the next step line. */
  manual?: ReactNode;
  status: ReactNode;
  /** The bench bar: the actions that must stay in reach while the body scrolls. */
  dock?: ReactNode;
  className?: string;
  children: ReactNode;
};

/**
 * The floor screen's frame with no behaviour: top bar (site, station, operator, sync), the
 * hero (step rail + next step line), the manual-entry slot, the status area, the body and the
 * sticky dock. `StationShell` adds the scanner; the gallery renders the frame alone.
 */
export function StationFrame({
  name,
  site,
  operator,
  pending,
  online = true,
  next,
  steps,
  step,
  manual,
  status,
  dock,
  className,
  children,
}: StationFrameProps) {
  return (
    <main className={cn("station", className)}>
      <header className="station-topbar">
        <div>
          <p className="station-eyebrow">Filletry · {site}</p>
          <h1>{name}</h1>
        </div>
        <div className="station-chips">
          <StationsLink />
          <StationBadge
            tone={operator ? "ink" : "warn"}
            icon={operator ? <UserRound /> : <KeyRound />}
            chip
          >
            {operator ?? "Identify operator"}
          </StationBadge>
          <SyncBadge pending={pending} online={online} />
        </div>
      </header>
      <NextStep next={next} steps={steps} step={step} />
      {manual}
      <div className="station-status">{status}</div>
      {children}
      {dock && (
        <div className="station-dock">
          <div className="station-dock-inner">{dock}</div>
        </div>
      )}
    </main>
  );
}

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
  steps,
  step,
  status,
  dock,
  className,
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
  /** The station's steps, in order, with `step` the current one (multi-step stations). */
  steps?: readonly string[];
  step?: number;
  status: ReactNode;
  dock?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const online = useOnline();
  // A hidden field is closed: the scanner must not stay paused behind it, nor the field reopen
  // (and take focus) when it shows again.
  const [wasHidden, setWasHidden] = useState(hideManual);
  if (wasHidden !== hideManual) {
    setWasHidden(hideManual);
    if (hideManual) setOpen(false);
  }
  const typing = open && !hideManual;
  return (
    <StationFrame
      name={name}
      site={site}
      operator={operator}
      pending={pending}
      online={online}
      next={next}
      steps={steps}
      step={step}
      status={status}
      dock={dock}
      className={className}
      manual={
        !hideManual && (
          <ManualEntry
            open={typing}
            onOpenChange={setOpen}
            disabled={paused}
            options={manual}
            label={manualLabel}
            onSubmit={(text, parsed) => onScan(text, parsed, "manual")}
          />
        )
      }
    >
      <ScanInput onScan={(raw, parsed) => onScan(raw, parsed, "scan")} paused={paused || typing} />
      {children}
    </StationFrame>
  );
}
