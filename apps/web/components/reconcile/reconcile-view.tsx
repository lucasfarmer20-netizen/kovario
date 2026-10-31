"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { Check, Inbox, Plus, ScanBarcode, Snowflake, Trash2 } from "lucide-react";
import { formatVariance, type ManualOptions, type VarianceBand } from "rules";
import { BAND_LABEL } from "@/components/variance/now-in-blast";
import { VarianceMeter } from "@/src/components/station/band";
import { speciesName } from "@/src/components/station/species-name";
import { BasketTile } from "@/src/components/station/basket-tile";
import { ManualEntry } from "@/src/components/station/manual-entry";
import { DisabledReason } from "@/src/components/station/next-step";
import { OrderTile } from "@/src/components/station/order-tile";
import { ScaleReadout, type ScaleState } from "@/src/components/station/scale-readout";

export type ReconcileQueueItem = {
  id: string;
  number: string;
  held: boolean;
  /** "Reds, Halibut · 42 lb expected". */
  detail: string;
  /** Time at reconcile: "12m", "3h". */
  age: string;
};
export type ReconcileOrder = {
  id: string;
  number: string;
  lines: { species: string; lb: number }[];
  expectedLb: number;
};
export type ReconcileBasket = {
  id: string;
  /** Tag code; null for an exchange basket. */
  code: string | null;
  exchange: boolean;
  weightLb: number;
  manual: boolean;
};

export type ReconcileViewProps = {
  /** First load not back yet: placeholders hold the layout so nothing jumps. */
  loading: boolean;
  queue: readonly ReconcileQueueItem[];
  order: ReconcileOrder | null;
  baskets: readonly ReconcileBasket[];
  selected: string | null;
  /** A weight on its way to the server, shown on its basket at once. */
  saving: { id: string; lb: number } | null;
  variance: {
    actualLb: number;
    pct: number | null;
    band: VarianceBand;
    limitPct: number;
    /** Over the limit with no hold yet: Send to Blast will be refused. */
    refusal: boolean;
    /** The open order's hold, back within the limit: what it waits on (#93). */
    waiting: string | null;
  };
  scale: { reading: number | null; state: ScaleState };
  manualWeight: { open: boolean; value: string };
  /** Why each control is disabled (docs/11: disabled buttons say why). */
  why: { pick: string | null; scale: string | null; send: string | null };
  /** Busy, pending scans, a PIN or manager PIN open. */
  disabled: boolean;
  basketField: { open: boolean; disabled: boolean; options: ManualOptions };
  holdPanel?: ReactNode;
  /** The suspect picker; scrolled into view when it opens. */
  suspectPicker?: ReactNode;
  suspectKey?: string | null;
  blastList: ReactNode;
  on: {
    openOrder: (id: string) => void;
    selectBasket: (id: string) => void;
    basketField: (open: boolean) => void;
    submitBasket: (text: string) => void;
    addExchange: () => void;
    accept: () => void;
    manualWeight: (open: boolean) => void;
    weightChange: (value: string) => void;
    saveManual: () => void;
    remove: () => void;
    send: () => void;
  };
};

// Shared now (Wave and Rollstock show species too); re-exported for existing imports.
export { speciesName };

const lb = (n: number) => `${n.toFixed(2)} lb`;

/**
 * The Reconcile floor (docs/06-STATIONS-UX.md Reconcile): the queue rail, and the open order as
 * one work surface. Left: what was expected, the variance instrument, the baskets. Right (the
 * dock): a hold if there is one, the scale and its Accept, and Send to Blast. On a phone the
 * dock's parts interleave so the scale sits under the variance and Send stays pinned to the
 * bottom of the order. Presentational: the live station and the gallery both render it.
 */
export function ReconcileView(props: ReconcileViewProps) {
  const { loading, queue, order, suspectPicker, suspectKey, blastList, disabled, on } = props;
  const picker = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!suspectKey) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    picker.current?.scrollIntoView?.({ block: "start", behavior: reduce ? "auto" : "smooth" });
  }, [suspectKey]);
  return (
    <div className="rc-floor" data-open={order ? "" : undefined}>
      <div className="rc-rail">
        <section className="station-card rc-queue" aria-label="Reconcile queue">
          <h2>
            Reconcile queue {!loading && <span className="rc-count st-num">{queue.length}</span>}
          </h2>
          {loading ? (
            <div className="rc-skeleton-list" aria-hidden>
              <div className="st-skeleton" />
              <div className="st-skeleton" />
              <div className="st-skeleton" />
            </div>
          ) : queue.length ? (
            <ul className="rc-queue-list">
              {queue.map((i) => (
                <li key={i.id}>
                  <OrderTile
                    number={i.number}
                    held={i.held}
                    detail={i.detail}
                    age={i.age}
                    current={i.id === order?.id}
                    disabled={disabled}
                    onOpen={() => on.openOrder(i.id)}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <div className="rc-empty">
              <Inbox size={32} aria-hidden />
              <p>
                <strong>Queue empty</strong>
                <br />
                Orders appear here when rollstock finishes them.
              </p>
            </div>
          )}
        </section>
        {blastList}
      </div>
      <div className="rc-main">
        {loading ? (
          <section
            className="station-card rc-order"
            aria-busy="true"
            aria-label="Opening reconcile"
          >
            <div className="rc-skeleton-order" aria-hidden>
              <div className="st-skeleton" style={{ height: 56, width: "40%" }} />
              <div className="st-skeleton" style={{ height: 120 }} />
              <div className="st-skeleton" style={{ height: 72 }} />
              <div className="st-skeleton" style={{ height: 72 }} />
            </div>
          </section>
        ) : order ? (
          <OrderCard {...props} order={order} />
        ) : (
          <section className="station-card rc-order rc-order-none">
            <div className="rc-none-art" aria-hidden>
              <ScanBarcode size={56} strokeWidth={1.6} />
            </div>
            <h2>No order open</h2>
            <p>Scan the tote on the bench, or tap an order in the queue.</p>
          </section>
        )}
        {suspectPicker && (
          <div ref={picker} className="rc-picker-anchor">
            {suspectPicker}
          </div>
        )}
      </div>
    </div>
  );
}

function OrderCard({
  order,
  baskets,
  selected,
  saving,
  variance,
  scale,
  manualWeight,
  why,
  disabled,
  basketField,
  holdPanel,
  on,
}: ReconcileViewProps & { order: ReconcileOrder }) {
  const heading = useId();
  const empty = baskets.length === 0;
  const weighed = baskets.filter((b) => b.weightLb > 0).length;
  const current = baskets.find((b) => b.id === selected);
  const target = current ? (current.code ? `basket ${current.code}` : "exchange basket") : null;
  const scaleOff = scale.state === "none";
  // Baskets still to weigh: the variance is a running figure, not a verdict yet.
  const toWeigh = baskets.length - weighed;
  return (
    <section className="station-card rc-order" aria-labelledby={heading}>
      <div className="rc-work">
        <div className="rc-head">
          <div>
            <p className="st-eyebrow">Open order</p>
            <h2 id={heading}>
              Order <span className="st-code">{order.number}</span>
            </h2>
          </div>
          <ul className="rc-lines" aria-label="Expected yield">
            {order.lines.map((l, n) => (
              <li key={n}>
                <span>{speciesName(l.species)}</span> <span className="st-num">{l.lb} lb</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rc-instrument" data-band={empty || toWeigh ? undefined : variance.band}>
          {empty ? (
            <p className="rc-empty-meter">
              Expected {order.expectedLb.toFixed(2)} lb · No baskets yet
            </p>
          ) : (
            <>
              <dl className="rc-figures">
                <div>
                  <dt>Actual</dt>
                  <dd className="st-num">{lb(variance.actualLb)}</dd>
                </div>
                <div>
                  <dt>Expected</dt>
                  <dd className="st-num">{lb(order.expectedLb)}</dd>
                </div>
                <div className="rc-figure-variance">
                  <dt>Variance</dt>
                  <dd className="st-num">{formatVariance(variance.pct)}</dd>
                </div>
              </dl>
              <VarianceMeter
                variancePct={variance.pct}
                limitPct={variance.limitPct}
                band={variance.band}
              />
              <p
                className={`station-band station-band-${variance.band}`}
                data-provisional={toWeigh ? "" : undefined}
              >
                {BAND_LABEL[variance.band]} (limit ±{variance.limitPct}%)
                {toWeigh > 0 && ` · so far, ${toWeigh} to weigh`}
              </p>
              {variance.refusal && toWeigh === 0 && (
                <p className="rc-warning">
                  Send to Blast will be refused and held with its rollstock neighbours
                </p>
              )}
              {variance.waiting && <p className="rc-waiting">{variance.waiting}</p>}
            </>
          )}
        </div>
        <div className="rc-baskets">
          <h3>
            Baskets{" "}
            {!empty && (
              <span className="rc-count st-num">
                {weighed}/{baskets.length} weighed
              </span>
            )}
          </h3>
          {empty && (
            <p className="station-hint rc-empty-baskets">
              <ScanBarcode size={28} aria-hidden />
              Scan basket to add it — or tap Enter manually.
            </p>
          )}
          {!empty && (
            <ul className="rc-basket-list">
              {baskets.map((b) => (
                <li key={b.id}>
                  <BasketTile
                    code={b.code}
                    exchange={b.exchange}
                    weightLb={b.weightLb}
                    manual={b.manual}
                    savingLb={saving?.id === b.id ? saving.lb : null}
                    selected={selected === b.id}
                    disabled={disabled}
                    onSelect={() => on.selectBasket(b.id)}
                  />
                </li>
              ))}
            </ul>
          )}
          <div className="station-actions station-add-basket">
            <ManualEntry
              open={basketField.open}
              onOpenChange={on.basketField}
              disabled={basketField.disabled}
              options={basketField.options}
              label="Basket number"
              placeholder="042"
              onSubmit={(text) => on.submitBasket(text)}
            />
            <button className="st-btn-secondary" disabled={disabled} onClick={on.addExchange}>
              <Plus size={22} aria-hidden />
              Add exchange basket
            </button>
          </div>
          <div className="rc-remove">
            <button className="st-btn-danger" disabled={disabled || !selected} onClick={on.remove}>
              <Trash2 size={20} aria-hidden />
              Remove selected basket
            </button>
            <DisabledReason reason={why.pick} />
          </div>
        </div>
      </div>
      <div className="rc-dock">
        {holdPanel}
        <div className="rc-weigh">
          <ScaleReadout reading={scale.reading} state={scale.state} target={target} />
          <button
            className="st-btn-hero st-btn-block"
            disabled={disabled || why.scale !== null}
            onClick={on.accept}
          >
            <Check size={26} strokeWidth={3} aria-hidden />
            Accept scale weight
          </button>
          <DisabledReason reason={why.scale} />
          {manualWeight.open ? (
            <form
              className="rc-manual-weight"
              onSubmit={(event) => {
                event.preventDefault();
                on.saveManual();
              }}
            >
              <label>
                Manual weight (lb)
                <input
                  autoFocus
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  step="0.01"
                  value={manualWeight.value}
                  onChange={(e) => on.weightChange(e.target.value)}
                />
              </label>
              <div className="station-actions">
                <button
                  type="submit"
                  disabled={disabled || !selected || !(Number(manualWeight.value) > 0)}
                >
                  Save manual weight
                </button>
                <button
                  type="button"
                  className="st-btn-secondary"
                  onClick={() => on.manualWeight(false)}
                >
                  Cancel manual weight
                </button>
              </div>
            </form>
          ) : (
            <>
              <button
                className={`st-btn-block ${scaleOff ? "" : "st-btn-secondary"}`}
                disabled={disabled || !selected}
                onClick={() => on.manualWeight(true)}
              >
                Enter weight manually
              </button>
              <DisabledReason reason={why.pick} />
            </>
          )}
        </div>
        <div
          className="rc-commit"
          data-tone={variance.refusal ? "warn" : undefined}
          data-ready={(!disabled && why.send === null && !holdPanel) || undefined}
        >
          <button
            className="st-btn-hero st-btn-block rc-send"
            disabled={disabled || why.send !== null}
            onClick={on.send}
          >
            <Snowflake size={26} aria-hidden />
            Send to Blast Freezer
          </button>
          <DisabledReason reason={why.send} />
        </div>
      </div>
    </section>
  );
}
