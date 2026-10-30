"use client";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { DisabledReason } from "./next-step";

export type StationButtonTone = "primary" | "secondary" | "ghost" | "danger" | "send";
export type StationButtonSize = "md" | "lg" | "hero";

/**
 * A floor button (docs/06-STATIONS-UX.md: ≥ 56 px, nothing hover-only). `why` is the reason
 * it is disabled, shown as helper text directly under it (docs/11-FLOOR-WORDING.md rule 5); a
 * non-empty `why` disables the button. `tone` says what the button is for: `primary` for the
 * step the operator is on, `send` for the one that finishes the order, `secondary` for the
 * rest, `ghost` for undo-able or rarely used actions, `danger` for removals.
 */
export function StationButton({
  tone = "secondary",
  size = "md",
  icon,
  why,
  block = false,
  className,
  wrapClassName,
  children,
  disabled,
  type = "button",
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  tone?: StationButtonTone;
  size?: StationButtonSize;
  icon?: ReactNode;
  why?: string | null | false;
  /** Fill the available width. */
  block?: boolean;
  wrapClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("sbtn-wrap", block && "sbtn-wrap-fill", wrapClassName)}>
      <button
        type={type}
        className={cn("sbtn", `sbtn-${tone}`, `sbtn-${size}`, block && "sbtn-block", className)}
        disabled={disabled || Boolean(why)}
        {...props}
      >
        {icon && (
          <span className="sbtn-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <span className="sbtn-label">{children}</span>
      </button>
      <DisabledReason reason={why} />
    </div>
  );
}
