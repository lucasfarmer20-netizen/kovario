"use client";
import { useId } from "react";
import { Check, Inbox, ListPlus, ScanBarcode, Undo2, WandSparkles } from "lucide-react";
import { CountProgress } from "@/src/components/station/count-progress";
import { DisabledReason } from "@/src/components/station/next-step";
import { OrderTile } from "@/src/components/station/order-tile";

export type WaveQueueItem = {
  id: string;
  number: string;
  /** "Reds, Halibut · 100 lb · 2 totes". */
  detail: string;
  /** "18h in cooler". */
  age: string;
  /** FAST PASS, DIRTY, RIBBING. */
  flags: string[];
  lb: number;
  totes: number;
};
export type WaveTile = { id: string; number: string; detail: string };
export type WaveMember = {
  id: string;
  number: string;
  /** "Reds · 100 lb". */
  detail: string;
  totes: number;
  /** Tote numbers already scanned into this wave. */
  scanned: readonly number[];
};
export type OpenWave = {
  id: string;
  number: string;
  state: "draft" | "verifying";
  scanned: number;
  expected: number;
  members: readonly WaveMember[];
};

export type WaveViewProps = {
  /** First load not back yet: placeholders hold the layout so nothing jumps. */
  loading: boolean;
  /** Holding orders not in a wave, oldest first. */
  queue: readonly WaveQueueItem[];
  /** Orders tapped into the new wave. */
  selected: readonly string[];
  /** The org's wave target (a suggestion, never a gate). */
  target: { lb: number; tolerance: number };
  /** Draft and verifying waves. */
  waves: readonly WaveTile[];
  /** The wave on screen; null shows the new-wave card. */
  wave: OpenWave | null;
  /** Why each forward action waits (docs/11: disabled buttons say why). */
  why: { start: string | null; advance: string | null; cancel: string | null };
  /** The open wave's last update was refused: Cancel wave is the way forward. */
  refused: boolean;
  /** Busy, PIN open. */
  disabled: boolean;
  on: {
    toggle: (id: string) => void;
    suggest: () => void;
    start: () => void;
    openWave: (id: string) => void;
    newWave: () => void;
    advance: () => void;
    cancel: () => void;
  };
};

/** Per-tote ticks up to this many totes on one order; more reads as a count. */
const TOTE_TICKS = 40;

/**
 * The Wave floor (docs/06-STATIONS-UX.md Wave): the cooler queue rail (open waves above it),
 * and one work card: the new wave being tapped together, or the open wave and its tote count.
 * The forward action (Start Verification / Complete) sits right under the card, above the
 * wave's orders (a big wave has dozens), and pins to the bottom of a phone once it can be used. Presentational: the live station and the
 * gallery both render it.
 */
export function WaveView(props: WaveViewProps) {
  const { loading, queue, selected, waves, wave, why, refused, disabled, on } = props;
  const forward = wave
    ? {
        label: wave.state === "draft" ? "Start Verification" : "Complete — Start Processing",
        why: why.advance,
        run: on.advance,
      }
    : { label: "Start Verification", why: why.start, run: on.start };
  const ready = !loading && !disabled && forward.why === null && !refused;
  return (
    <div className="wv-floor" data-open={wave ? "" : undefined}>
      <div className="st-rail wv-rail">
        {waves.length > 0 && (
          <section className="station-card" aria-label="Open waves">
            <h2 className="st-card-head">
              Open waves <span className="st-count st-num">{waves.length}</span>
            </h2>
            <ul className="st-list">
              {waves.map((w) => (
                <li key={w.id}>
                  <OrderTile
                    number={w.number}
                    detail={w.detail}
                    current={w.id === wave?.id}
                    disabled={disabled}
                    onOpen={() => on.openWave(w.id)}
                  />
                </li>
              ))}
            </ul>
            {wave && (
              <button
                className="st-btn-secondary st-btn-block wv-new"
                disabled={disabled}
                onClick={on.newWave}
              >
                <ListPlus size={22} aria-hidden />
                New wave
              </button>
            )}
          </section>
        )}
        <section className="station-card" aria-label="Cooler queue">
          <h2 className="st-card-head">
            Cooler · oldest first{" "}
            {!loading && <span className="st-count st-num">{queue.length}</span>}
          </h2>
          {loading ? (
            <div className="st-skeleton-list" aria-hidden>
              <div className="st-skeleton" />
              <div className="st-skeleton" />
              <div className="st-skeleton" />
            </div>
          ) : queue.length ? (
            <ul className="st-list">
              {queue.map((i) => (
                <li key={i.id}>
                  <OrderTile
                    number={i.number}
                    detail={i.detail}
                    age={i.age}
                    flags={i.flags}
                    pressed={selected.includes(i.id)}
                    disabled={disabled}
                    onOpen={() => on.toggle(i.id)}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <div className="st-empty">
              <Inbox size={32} aria-hidden />
              <p>
                <strong>No orders waiting in the cooler</strong>
                <br />
                Orders appear here when the Intake station saves them.
              </p>
            </div>
          )}
        </section>
      </div>
      <div className="st-main wv-main">
        {loading ? (
          <section className="station-card" aria-busy="true" aria-label="Opening wave station">
            <div className="st-skeleton-stack" aria-hidden>
              <div className="st-skeleton" style={{ height: 56, width: "40%" }} />
              <div className="st-skeleton" style={{ height: 120 }} />
              <div className="st-skeleton" style={{ height: 72 }} />
            </div>
          </section>
        ) : wave ? (
          <WaveCard
            wave={wave}
            refused={refused}
            disabled={disabled}
            cancelWhy={why.cancel}
            onCancel={on.cancel}
          />
        ) : (
          <NewWaveCard {...props} />
        )}
      </div>
      <div
        className="wv-commit"
        data-ready={ready || undefined}
        data-tone={refused ? "warn" : undefined}
      >
        <button
          className="st-btn-hero st-btn-block"
          disabled={loading || disabled || forward.why !== null}
          onClick={forward.run}
        >
          {wave?.state === "verifying" ? (
            <Check size={26} strokeWidth={3} aria-hidden />
          ) : (
            <ScanBarcode size={26} aria-hidden />
          )}
          {forward.label}
        </button>
        <DisabledReason reason={loading ? null : forward.why} />
      </div>
      {wave && !loading && <WaveOrders wave={wave} />}
    </div>
  );
}

function NewWaveCard({ queue, selected, target, disabled, on }: WaveViewProps) {
  const heading = useId();
  const chosen = queue.filter((i) => selected.includes(i.id));
  const lb = chosen.reduce((sum, i) => sum + i.lb, 0);
  const totes = chosen.reduce((sum, i) => sum + i.totes, 0);
  return (
    <section className="station-card wv-card" aria-labelledby={heading}>
      <div className="st-item-head">
        <div>
          <p className="st-eyebrow">Next wave</p>
          <h2 id={heading}>New wave</h2>
        </div>
        <button
          className="st-btn-secondary"
          disabled={disabled || !queue.length}
          onClick={on.suggest}
        >
          <WandSparkles size={22} aria-hidden />
          Suggest FIFO fill
        </button>
      </div>
      <div className="wv-instrument">
        {chosen.length ? (
          <>
            <p className="wv-sum">
              <span className="st-num">{`${chosen.length} selected · ${lb} lb`}</span>
              <span className="wv-sum-totes st-num">
                {totes} {totes === 1 ? "tote" : "totes"}
              </span>
            </p>
            <TargetBar lb={lb} target={target.lb} tolerance={target.tolerance} />
            <ul className="wv-chosen" aria-label="Orders in the new wave">
              {chosen.map((i) => (
                <li key={i.id} className="st-code">
                  {i.number}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="wv-empty">
            <ListPlus size={28} aria-hidden />
            No orders yet. Tap orders in the cooler queue, or Suggest FIFO fill.
          </p>
        )}
        <p className="wv-target">
          Target {target.lb} ± {target.tolerance} lb · suggestion only
        </p>
      </div>
    </section>
  );
}

/**
 * The tapped weight against the org's target band: a bar with the band marked. Decorative
 * (the figures above and the target line say the same in words); no verdict, the target is
 * a suggestion (docs/04 §3).
 */
function TargetBar({ lb, target, tolerance }: { lb: number; target: number; tolerance: number }) {
  const max = Math.max(lb, target + tolerance) * 1.15 || 1;
  const at = (n: number) => `${Math.min(100, Math.max(0, (n / max) * 100))}%`;
  return (
    <div className="wv-target-bar" aria-hidden>
      <span
        className="wv-target-zone"
        style={{
          left: at(target - tolerance),
          width: `calc(${at(target + tolerance)} - ${at(target - tolerance)})`,
        }}
      />
      <span className="wv-target-fill" style={{ width: at(lb) }} />
      <span className="wv-target-mark" style={{ left: at(target) }} />
    </div>
  );
}

function WaveCard({
  wave,
  refused,
  disabled,
  cancelWhy,
  onCancel,
}: {
  wave: OpenWave;
  refused: boolean;
  disabled: boolean;
  cancelWhy: string | null;
  onCancel: () => void;
}) {
  const heading = useId();
  const left = wave.expected - wave.scanned;
  const label =
    wave.state === "draft"
      ? "Start verification, then scan each tote"
      : wave.expected > 0 && left <= 0
        ? "Every tote scanned"
        : `${left} to scan`;
  return (
    <section className="station-card wv-card" aria-labelledby={heading}>
      <div className="st-item-head">
        <div>
          <p className="st-eyebrow">{wave.state === "draft" ? "Not started" : "Checking totes"}</p>
          <h2 id={heading}>
            Wave <span className="st-code">{wave.number}</span>
          </h2>
        </div>
        {/* Away from the forward action; the filled way forward once an update is refused. */}
        <div className="wv-cancel">
          <button
            className={refused ? "" : "st-btn-danger"}
            disabled={disabled || cancelWhy !== null}
            onClick={onCancel}
          >
            <Undo2 size={20} aria-hidden />
            Cancel wave — Return to holding
          </button>
          <DisabledReason reason={cancelWhy} />
        </div>
      </div>
      <CountProgress done={wave.scanned} total={wave.expected} noun="totes" label={label} />
    </section>
  );
}

/**
 * The orders in the open wave, each with its totes ticking off. Orders with a tote still to
 * scan come first, so on a big wave the missing tote is at the top of the list.
 */
function WaveOrders({ wave }: { wave: OpenWave }) {
  const heading = useId();
  const left = (m: WaveMember) => m.scanned.length < m.totes;
  const members = [...wave.members.filter(left), ...wave.members.filter((m) => !left(m))];
  return (
    <section className="station-card wv-orders" aria-labelledby={heading}>
      <h3 id={heading} className="st-card-head">
        Orders in this wave <span className="st-count st-num">{wave.members.length}</span>
      </h3>
      <ul className="wv-members" aria-label="Orders in this wave">
        {members.map((m) => (
          <li key={m.id} data-done={!left(m) || undefined}>
            <span className="wv-member-head">
              <span className="st-code wv-member-number">{m.number}</span>
              <span className="wv-member-detail">{m.detail}</span>
            </span>
            {m.totes <= TOTE_TICKS ? (
              <ol className="wv-totes" aria-label={`Totes of ${m.number}`}>
                {Array.from({ length: m.totes }, (_, n) => n + 1).map((tote) => {
                  const done = m.scanned.includes(tote);
                  return (
                    <li key={tote} data-done={done || undefined}>
                      {done && <Check size={16} strokeWidth={3.4} aria-hidden />}
                      <span className="st-sr">Tote </span>
                      {tote}
                      <span className="st-sr">{done ? " scanned" : " to scan"}</span>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <span className="wv-member-detail st-num">
                {m.scanned.length} / {m.totes} totes
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
