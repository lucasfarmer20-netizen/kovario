"use client";
import type { ComponentProps, CSSProperties, ElementType, ReactNode } from "react";
import { CircleCheck, Info, OctagonX, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

/** A floor card. `held` rings it in the over-limit colour (a variance hold, #87). */
export function StationCard({
  className,
  held = false,
  children,
  ...props
}: ComponentProps<"section"> & { held?: boolean }) {
  return (
    <section className={cn("station-card", held && "station-card-held", className)} {...props}>
      {children}
    </section>
  );
}

/** Card header: an eyebrow, the title and something on the right (a count, a figure). */
export function CardHead({
  eyebrow,
  title,
  aside,
  as: Tag = "h2",
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  aside?: ReactNode;
  as?: "h2" | "h3";
}) {
  return (
    <div className="station-card-head">
      <div>
        {eyebrow && <span className="station-card-eyebrow">{eyebrow}</span>}
        <Tag>{title}</Tag>
      </div>
      {aside && <div className="station-card-aside">{aside}</div>}
    </div>
  );
}

/** A section inside a card: a small uppercase title with an optional aside. */
export function SectionTitle({ aside, children }: { aside?: ReactNode; children: ReactNode }) {
  return (
    <h3 className="station-section-title">
      <span>{children}</span>
      {aside && <span>{aside}</span>}
    </h3>
  );
}

export type BadgeTone = "neutral" | "ink" | "quiet" | "accent" | "warn" | "danger" | "ok";

export function StationBadge({
  tone = "neutral",
  icon,
  chip = false,
  className,
  children,
  ...props
}: ComponentProps<"span"> & { tone?: BadgeTone; icon?: ReactNode; chip?: boolean }) {
  return (
    <span
      className={cn(
        "station-badge",
        tone !== "neutral" && `station-badge-${tone}`,
        chip && "station-badge-chip",
        className,
      )}
      {...props}
    >
      {icon && (
        <span aria-hidden="true" className="inline-grid">
          {icon}
        </span>
      )}
      {children}
    </span>
  );
}

export type NoticeTone = "neutral" | "accent" | "success" | "warn" | "danger";
const NOTICE_ICON: Record<NoticeTone, ElementType> = {
  neutral: Info,
  accent: Info,
  success: CircleCheck,
  warn: TriangleAlert,
  danger: OctagonX,
};

/**
 * What just happened, or what is in the way, where the operator is looking: an icon, a title
 * and a line of text (docs/11 rule 4: what happened, then what to do). Not a toast: it stays
 * until the next action replaces it.
 */
export function StationNotice({
  tone = "neutral",
  title,
  action,
  role = "status",
  className,
  children,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  action?: ReactNode;
  role?: "status" | "alert" | "note";
  className?: string;
  children?: ReactNode;
}) {
  const Icon = NOTICE_ICON[tone];
  return (
    <div
      role={role}
      className={cn("station-notice", tone !== "neutral" && `station-notice-${tone}`, className)}
    >
      <Icon aria-hidden="true" />
      <div className="station-notice-body">
        {title && <div className="station-notice-title">{title}</div>}
        {children && <div className="station-notice-text">{children}</div>}
        {action && <div className="station-notice-action">{action}</div>}
      </div>
    </div>
  );
}

/** An empty list that says what fills it. */
export function StationEmpty({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="station-empty">
      {icon}
      <p className="station-empty-title">{title}</p>
      {children && <p>{children}</p>}
    </div>
  );
}

/** A loading placeholder the size of what it stands in for, so nothing jumps when data lands. */
export function Skeleton({
  height = 20,
  width = "100%",
  className,
  style,
}: {
  height?: number | string;
  width?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn("station-skeleton", className)}
      style={{ height, width, ...style }}
    />
  );
}
