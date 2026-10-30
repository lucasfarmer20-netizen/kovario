"use client";
import type { ReactNode } from "react";
import {
  Check,
  Clock,
  Fish,
  Keyboard,
  Lock,
  Package,
  Plus,
  Scale,
  ScanLine,
  Snowflake,
  Trash,
} from "lucide-react";
import type { ManualOptions, VarianceBand } from "rules";
import { StationButton } from "@/src/components/station/station-button";
import { StationFrame } from "@/src/components/station/station-shell";
import {
  CardHead,
  SectionTitle,
  Skeleton,
  StationBadge,
  StationCard,
  StationEmpty,
} from "@/src/components/station/station-ui";
import { StationRow } from "@/src/components/station/station-row";
import { VarianceMeter } from "@/src/components/station/variance-meter";
import { ScaleReadout, type ScaleState } from "@/src/components/station/scale-readout";
import { ManualEntry } from "@/src/components/station/manual-entry";

/** The station's steps (docs/11-FLOOR-WORDING.md, Reconcile). */
export const STEPS = ["Add baskets", "Weigh", "Send to Blast"] as const;

/** The frame while the session loads: the real layout, with placeholders where data lands. */
export function ReconcileSkeleton() {
  return (
    <StationFrame
      name="Reconcile"
      site="…"
      operator={null}
      pending={0}
      next="Opening reconcile…"
      steps={STEPS}
      step={0}
      status={<div className="station-feedback" />}
    >
      <div className="station-workspace">
        <StationCard aria-busy="true">
          <Skeleton height={28} width="40%" />
          <div style={{ height: 16 }} />
          <Skeleton height={64} />
          <div style={{ height: 8 }} />
          <Skeleton height={64} />
        </StationCard>
        <StationCard aria-busy="true">
          <Skeleton height={28} width="55%" />
          <div style={{ height: 16 }} />
          <Skeleton height={64} />
        </StationCard>
      </div>
    </StationFrame>
  );
}

/** A basket row as the order card shows it. */
export type OrderBasket = {
  id: string;
  name: string;
  weightLb: number;
  manual: boolean;
};

/**
 * The order card (docs/06 Reconcile): the order's lines, its variance once there is something to
 * judge (#97), the basket list, the add-basket row (Enter manually next to Add exchange basket)
 * and the selected basket's actions. Presentational: the station owns the data and the RPCs.
 */
export function OrderCard({
  number,
  toteCount,
  lines,
  expected,
  baskets,
  selected,
  lastAdded,
  variance,
  band,
  limit,
  held,
  waiting,
  disabled,
  pickWhy,
  manualEntry,
  onSelect,
  onExchange,
  onRemove,
  weightForm,
}: {
  number: string;
  toteCount: number;
  lines: readonly { species: string; lb: number }[];
  expected: number;
  baskets: readonly OrderBasket[];
  selected: string | null;
  lastAdded: string | null;
  variance: number | null;
  band: VarianceBand;
  limit: number;
  /** A variance hold covers this order (the card is ringed; the hold panel follows it). */
  held: boolean;
  /** What a fixed order's hold still waits on (#93), shown under the band. */
  waiting: string | null;
  disabled: boolean;
  /** Why the selected-basket actions are disabled: no basket yet, or none tapped. */
  pickWhy: string | null;
  manualEntry: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    disabled: boolean;
    options: ManualOptions;
    onSubmit: (text: string) => void;
  };
  onSelect: (id: string) => void;
  onExchange: () => void;
  onRemove: () => void;
  weightForm: {
    open: boolean;
    value: string;
    canSave: boolean;
    onOpen: () => void;
    onChange: (value: string) => void;
    onSave: () => void;
    onCancel: () => void;
  };
}) {
  const empty = baskets.length === 0;
  const selectedBasket = baskets.find((b) => b.id === selected) ?? null;
  const weighedCount = baskets.filter((b) => b.weightLb > 0).length;
  return (
    <StationCard held={held}>
      <CardHead
        title={`Order ${number}`}
        aside={
          <>
            {toteCount} {toteCount === 1 ? "tote" : "totes"} · {weighedCount}/{baskets.length}{" "}
            weighed
          </>
        }
      />
      <div className="station-chips">
        {lines.map((l, n) => (
          <StationBadge key={n} icon={<Fish />}>
            {l.species} · {l.lb} lb
          </StationBadge>
        ))}
      </div>
      <div className="station-section">
        {empty ? (
          <p className="station-meta">Expected {expected.toFixed(2)} lb · No baskets yet</p>
        ) : (
          <VarianceMeter
            actual={baskets.reduce((sum, b) => sum + b.weightLb, 0)}
            expected={expected}
            variance={variance}
            band={band}
            limit={limit}
            note={
              band === "over" &&
              !held && (
                <span className="station-band-note">
                  {" "}
                  — Send to Blast will be refused and held with its rollstock neighbours
                </span>
              )
            }
          >
            {waiting && <p className="station-meta">{waiting}</p>}
          </VarianceMeter>
        )}
      </div>
      <div className="station-section">
        <SectionTitle aside={empty ? undefined : `${baskets.length}`}>Baskets</SectionTitle>
        {empty ? (
          <StationEmpty
            icon={<ScanLine />}
            title="Scan basket to add it — or tap Enter manually."
          />
        ) : (
          <div className="station-rows">
            {baskets.map((b) => {
              const weighed = b.weightLb > 0;
              return (
                <StationRow
                  key={b.id}
                  lead={weighed ? <Check /> : <Package />}
                  leadTone={weighed ? "ok" : undefined}
                  title={b.name}
                  selected={selected === b.id}
                  entered={lastAdded === b.id}
                  disabled={disabled}
                  onClick={() => onSelect(b.id)}
                  trail={
                    <>
                      {weighed ? (
                        <span className="station-row-figure">{b.weightLb} lb</span>
                      ) : (
                        <span className="station-row-figure station-row-figure-empty">
                          Not weighed
                        </span>
                      )}
                      {b.manual && (
                        <>
                          <span className="sr-only"> </span>
                          <StationBadge tone="warn" icon={<Keyboard />}>
                            MANUAL WEIGHT
                          </StationBadge>
                        </>
                      )}
                    </>
                  }
                />
              );
            })}
          </div>
        )}
        <div className="station-actions station-add-basket">
          <ManualEntry
            open={manualEntry.open}
            onOpenChange={manualEntry.onOpenChange}
            disabled={manualEntry.disabled}
            options={manualEntry.options}
            label="Basket number"
            placeholder="042"
            onSubmit={(text) => manualEntry.onSubmit(text)}
          />
          <StationButton icon={<Plus />} disabled={disabled} onClick={onExchange}>
            Add exchange basket
          </StationButton>
        </div>
      </div>
      <div className="station-section">
        <SectionTitle aside={selectedBasket?.name}>Selected basket</SectionTitle>
        <div className="station-actions">
          <StationButton
            icon={<Keyboard />}
            disabled={disabled}
            why={pickWhy}
            onClick={weightForm.onOpen}
          >
            Enter weight manually
          </StationButton>
          <StationButton
            tone="danger"
            icon={<Trash />}
            disabled={disabled}
            why={pickWhy}
            onClick={onRemove}
          >
            Remove selected basket
          </StationButton>
        </div>
        {weightForm.open && (
          <div className="station-inline-form">
            <label className="station-field station-field-weight">
              Manual weight (lb)
              <input
                autoFocus
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                value={weightForm.value}
                onChange={(e) => weightForm.onChange(e.target.value)}
              />
            </label>
            <div className="station-actions">
              <StationButton
                tone="primary"
                icon={<Check />}
                disabled={disabled || !weightForm.canSave}
                onClick={weightForm.onSave}
              >
                Save manual weight
              </StationButton>
              <StationButton tone="ghost" onClick={weightForm.onCancel}>
                Cancel manual weight
              </StationButton>
            </div>
          </div>
        )}
      </div>
    </StationCard>
  );
}

/**
 * The bench bar (docs/06 "live scale reading widget"): the scale's reading, Accept and Send
 * to Blast Freezer, sticky at the bottom so they stay in reach however long the basket list
 * grows. Accept is the primary while a basket waits for a weight; Send takes over once every
 * basket is weighed.
 */
export function ReconcileDock({
  scale,
  acceptLabel,
  acceptPrimary,
  scaleWhy,
  sendWhy,
  disabled,
  onAccept,
  onSend,
}: {
  scale: ScaleState;
  acceptLabel: string;
  acceptPrimary: boolean;
  scaleWhy: string | null;
  sendWhy: string | null;
  disabled: boolean;
  onAccept: () => void;
  onSend: () => void;
}) {
  return (
    <>
      <ScaleReadout state={scale} className="station-dock-scale" />
      <StationButton
        tone={acceptPrimary ? "primary" : "secondary"}
        size="hero"
        icon={<Scale />}
        disabled={disabled}
        why={scaleWhy}
        onClick={onAccept}
      >
        {acceptLabel}
      </StationButton>
      <StationButton
        tone="send"
        size="hero"
        icon={<Snowflake />}
        disabled={disabled}
        why={sendWhy}
        onClick={onSend}
      >
        Send to Blast Freezer
      </StationButton>
    </>
  );
}

/** One order waiting at reconcile, as the queue shows it. */
export type QueueOrder = {
  id: string;
  number: string;
  meta: string;
  held: boolean;
  open: boolean;
  /** "18m" / "2h" since rollstock finished it, or null. */
  age: string | null;
};

/** The reconcile queue (FIFO by rollstock_done_at): tap an order to open it. */
export function QueueCard({
  orders,
  title,
  eyebrow = "Reconcile queue",
  aside,
  disabled,
  onOpen,
}: {
  orders: readonly QueueOrder[];
  title: string;
  eyebrow?: string;
  aside?: ReactNode;
  disabled: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <StationCard>
      <CardHead eyebrow={eyebrow} title={title} aside={aside} />
      {orders.length ? (
        <div className="station-rows">
          {orders.map((o) => (
            <StationRow
              key={o.id}
              lead={o.held ? <Lock /> : <Package />}
              open={o.open}
              title={o.number}
              meta={o.meta}
              trail={
                <>
                  {o.held && (
                    <StationBadge tone="danger" icon={<Lock />}>
                      HELD
                    </StationBadge>
                  )}
                  {o.held && <span className="sr-only"> </span>}
                  {o.open ? (
                    <StationBadge tone="accent">Open</StationBadge>
                  ) : (
                    !o.held &&
                    o.age && (
                      <StationBadge tone="quiet" icon={<Clock />}>
                        {o.age}
                      </StationBadge>
                    )
                  )}
                </>
              }
              disabled={disabled}
              onClick={() => onOpen(o.id)}
            />
          ))}
        </div>
      ) : (
        <StationEmpty icon={<Fish />} title="Queue empty">
          Orders arrive here as rollstock finishes them.
        </StationEmpty>
      )}
    </StationCard>
  );
}
