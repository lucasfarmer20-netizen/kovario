"use client";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One tappable row in a floor list (a basket, an order in the queue): a lead glyph, a title
 * with a line of meta, and a figure or badges on the right. The whole row is the button
 * (≥ 64 px). `selected` is the row an action will write to (aria-pressed); `open` marks the
 * order the station is working on. The separators between the parts are read, not seen, so
 * the row's accessible name reads "Basket 005 · 12.40 lb".
 */
export function StationRow({
  lead,
  leadTone,
  title,
  meta,
  trail,
  selected,
  open = false,
  entered = false,
  className,
  ...props
}: Omit<ComponentProps<"button">, "title"> & {
  lead?: ReactNode;
  leadTone?: "ok";
  title: ReactNode;
  meta?: ReactNode;
  trail?: ReactNode;
  selected?: boolean;
  open?: boolean;
  /** Animate in (a row that was just added). */
  entered?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        "station-row",
        open && "station-row-open",
        entered && "station-row-enter",
        className,
      )}
      aria-pressed={selected}
      {...props}
    >
      <span
        className={cn("station-row-lead", leadTone === "ok" && "station-row-lead-ok")}
        aria-hidden="true"
      >
        {lead}
      </span>
      <span className="station-row-body">
        <span className="station-row-title">{title}</span>
        {meta && (
          <>
            <span className="sr-only"> · </span>
            <span className="station-row-meta">{meta}</span>
          </>
        )}
      </span>
      {trail && (
        <>
          <span className="sr-only"> · </span>
          <span className="station-row-trail">{trail}</span>
        </>
      )}
    </button>
  );
}
