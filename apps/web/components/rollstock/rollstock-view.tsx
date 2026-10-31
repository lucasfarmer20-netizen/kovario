"use client";
import {
  CircleCheck,
  CircleSlash,
  Inbox,
  PenLine,
  ScanBarcode,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { DisabledReason } from "@/src/components/station/next-step";
import { OrderTile } from "@/src/components/station/order-tile";
import { CountProgress } from "@/src/components/station/count-progress";

/** The order open at rollstock. */
export type RollstockOrder = {
  id: string;
  number: string;
  /** Species names, once each ("Reds", "Silvers"). */
  species: readonly string[];
  /** Totes scanned (wave + rollstock) of the order's `totes`. */
  scanned: number;
  totes: number;
  /** "FAST PASS", "DIRTY", "RIBBING": shown as badges. */
  flags: readonly string[];
  /** The order's notes for the line, each with what it is about. */
  notes: readonly { label: string; text: string }[];
};
/** An order on its way to rollstock (pulled from the cooler, or in it: a bypass). */
export type RollstockNextRow = {
  id: string;
  number: string;
  detail: string;
  age: string;
  flags?: readonly string[];
};
/** An order at rollstock that is not the open one (another station's, or left open). */
export type RollstockResumeRow = { id: string; number: string };
/**
 * The server refused to move the open order on (`Missing totes: X of Y scanned`): a tote of
 * another order was scanned, or Finish queue tapped, before every tote was in. `next` is the
 * order whose tote was refused; it opens once a manager approves.
 */
export type RollstockBlock = { next: string | null };

export type RollstockViewProps = {
  /** First load not back yet: placeholders hold the layout so nothing jumps. */
  loading: boolean;
  order: RollstockOrder | null;
  /** An order is remembered as open here but is no longer at rollstock. */
  stale: boolean;
  nextUp: readonly RollstockNextRow[];
  resume: readonly RollstockResumeRow[];
  /** Only with `order`: the manager path takes the top of the work area. */
  blocked: RollstockBlock | null;
  /** The override reason, typed in an explicit editing mode that pauses the scanner. */
  reason: string;
  editingReason: boolean;
  /**
   * Why every tap waits (scans still sending); "" while it waits with nothing to say yet (a
   * quick round trip); null: live.
   */
  sending: string | null;
  /** Finish queue and the override go straight to the server: offline, they wait and say so. */
  online: boolean;
  /** A tap is on its way, or a PIN sheet is up. */
  busy: boolean;
  on: {
    finish: () => void;
    resume: (id: string) => void;
    clearStale: () => void;
    editReason: (open: boolean) => void;
    reasonChange: (value: string) => void;
    approve: () => void;
  };
};

export const ROLLSTOCK_STEPS = ["Open an order", "Scan its totes", "Next order"] as const;
/** The override needs a reason of at least this many characters (rollstock_scan_advance). */
export const OVERRIDE_REASON_MIN = 3;

/**
 * The next step line and current step (docs/11-FLOOR-WORDING.md, Rollstock): scan a tote to
 * open an order, then the next tote. Once every tote is in and nothing is next up, the step is
 * the tap on Finish queue; while totes are missing, a warning names the order.
 */
export function rollstockNextStep(
  order: Pick<RollstockOrder, "number" | "scanned" | "totes"> | null,
  blocked: RollstockBlock | null,
  nextUp: number,
  stale = false,
): { next: string; step: number; tone?: "warn" } {
  if (!order) return { next: stale ? "Tap Clear stale open order" : "Scan a tote", step: 0 };
  const complete = order.scanned >= order.totes && order.totes > 0;
  if (blocked && !complete)
    return {
      next: `Scan the missing ${order.totes - order.scanned === 1 ? "tote" : "totes"} for ${order.number}`,
      step: 1,
      tone: "warn",
    };
  if (!complete) return { next: "Scan the next tote", step: 1 };
  return { next: nextUp > 0 ? "Scan the next tote" : "Tap Finish queue", step: 2 };
}

/**
 * The Rollstock floor (docs/06-STATIONS-UX.md Rollstock): scan only. The open order is the hero:
 * its number and tote count, species, note badges and notes, its tote count and what to
 * scan next. NEXT UP is below it; Finish queue is de-emphasised, the filled button only when it
 * is the next step. When the server refuses to move an order on with totes missing, the manager
 * path takes the top. Presentational: the live station and the gallery both render it.
 */
export function RollstockView(props: RollstockViewProps) {
  const { loading, order, stale, nextUp, resume, blocked, sending, busy, on } = props;
  const complete = order ? order.scanned >= order.totes && order.totes > 0 : false;
  const finishNext = complete && nextUp.length === 0 && !blocked;
  const hero = loading ? (
    // The shape of the open order card it becomes, so nothing jumps.
    <section className="station-card st-item" aria-busy="true" aria-label="Opening rollstock">
      <div className="st-skeleton" style={{ height: 40, width: "45%" }} aria-hidden />
      <div className="st-skeleton" style={{ height: 24 }} aria-hidden />
      <div className="st-skeleton" style={{ height: 72 }} aria-hidden />
    </section>
  ) : order ? (
    <section className="station-card st-item" aria-label="Open at rollstock">
      <div className="st-item-head">
        <div>
          <p className="st-eyebrow">Open at rollstock</p>
          <h2>
            Order <span className="st-code">{order.number}</span>
            <span className="st-item-sub">
              {" "}
              · tote {order.scanned} of {order.totes}
            </span>
          </h2>
        </div>
        {order.species.length > 0 && (
          <ul className="st-facts" aria-label="Species">
            {order.species.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        )}
        {order.flags.length > 0 && (
          <p className="st-order-flags" aria-label="Order flags">
            {order.flags.map((f) => (
              <span key={f} className="station-badge st-badge-flag">
                {f}
              </span>
            ))}
          </p>
        )}
      </div>
      <CountProgress
        done={order.scanned}
        total={order.totes}
        noun={order.totes === 1 ? "tote" : "totes"}
        label={complete ? "Every tote scanned" : `${order.totes - order.scanned} to scan`}
      />
      {order.notes.length > 0 && (
        <dl className="st-notes">
          {order.notes.map((n) => (
            <div key={n.label}>
              <dt>{n.label}</dt>
              <dd>{n.text}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="st-expect">
        {complete ? <CircleCheck size={28} aria-hidden /> : <ScanBarcode size={28} aria-hidden />}
        <span>
          {complete && nextUp.length > 0 ? (
            <>
              <strong>Scan the next order&apos;s tote</strong>
              <br />
              This order then moves on to reconcile.
            </>
          ) : complete ? (
            <>
              <strong>Last order? Tap Finish queue</strong>
              <br />
              It sends this order to reconcile.
            </>
          ) : (
            <>
              <strong>Scan its next tote</strong>
              <br />
              Every tote is scanned before the order moves on to reconcile.
            </>
          )}
        </span>
      </p>
      <Finish {...props} primary={finishNext} />
    </section>
  ) : stale ? (
    <section className="station-card st-hero-empty" aria-label="Open at rollstock">
      <div className="st-hero-art" aria-hidden>
        <CircleSlash size={56} strokeWidth={1.6} />
      </div>
      <h2>Open order not found</h2>
      <p>It has moved on from rollstock. Clear it, then scan a tote.</p>
      <button type="button" disabled={busy || sending !== null} onClick={on.clearStale}>
        Clear stale open order
      </button>
      <DisabledReason reason={sending} />
    </section>
  ) : (
    <section className="station-card st-hero-empty" aria-label="Open at rollstock">
      <div className="st-hero-art" aria-hidden>
        <ScanBarcode size={56} strokeWidth={1.6} />
      </div>
      <h2>No order open</h2>
      <p>Scan a tote to open an order.</p>
      <Finish {...props} primary={false} />
    </section>
  );
  return (
    <div className="st-floor">
      <div className="st-main">
        {order && blocked && !complete && (
          <MissingTotes {...props} order={order} blocked={blocked} />
        )}
        {hero}
        <section className="station-card" aria-label="Next up">
          <h2 className="st-card-head">
            <span>Next up</span>
            {!loading && <span className="st-count st-num">{nextUp.length}</span>}
          </h2>
          {loading ? (
            <div className="st-skeleton-list" aria-hidden>
              <div className="st-skeleton" />
              <div className="st-skeleton" />
            </div>
          ) : nextUp.length > 0 ? (
            <ul className="st-list">
              {nextUp.map((i) => (
                <li key={i.id}>
                  <OrderTile number={i.number} detail={i.detail} age={i.age} flags={i.flags} />
                </li>
              ))}
            </ul>
          ) : (
            <div className="st-empty">
              <Inbox size={32} aria-hidden />
              <p>
                <strong>Queue empty</strong>
                <br />
                Orders appear here once they are dropped off.
              </p>
            </div>
          )}
        </section>
        {!loading && resume.length > 0 && (
          <section className="station-card" aria-label="Also open at rollstock">
            <h2 className="st-card-head">
              <span>Also open at rollstock</span>
              <span className="st-count st-num">{resume.length}</span>
            </h2>
            <p className="station-hint">
              Left open at another station. Resume one to finish it here.
            </p>
            <ul className="st-list">
              {resume.map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    className="st-btn-secondary st-btn-block"
                    disabled={busy || sending !== null}
                    onClick={() => on.resume(i.id)}
                  >
                    Resume <span className="st-code">{i.number}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

/** Finish queue: de-emphasised (outlined) unless it is the next step; the why under it. */
/** Why a tap that goes straight to the server waits; null when it is live. */
function serverWhy({ sending, online }: Pick<RollstockViewProps, "sending" | "online">) {
  return online ? sending : "Needs a connection. Scans still save on this tablet.";
}

function Finish(props: RollstockViewProps & { primary: boolean }) {
  const { order, busy, on, primary } = props;
  const why = serverWhy(props);
  return (
    <div className="st-finish">
      <button
        type="button"
        className={primary ? "st-btn-block" : "st-btn-secondary"}
        disabled={!order || busy || why !== null}
        onClick={on.finish}
      >
        Finish queue
      </button>
      <DisabledReason reason={!order ? "Scan a tote first" : why} />
    </div>
  );
}

/**
 * The manager path (docs/12 "Held / needs a manager"): the open order still misses totes, so the
 * server refused to move it on. Scanning the missing tote clears it; otherwise a manager approves
 * with a reason (manager PIN, or a manager account directly) and the refused order opens.
 */
function MissingTotes(
  props: RollstockViewProps & { order: RollstockOrder; blocked: RollstockBlock },
) {
  const { order, blocked, reason, editingReason, busy, on } = props;
  const why = serverWhy(props);
  const short = reason.trim().length < OVERRIDE_REASON_MIN;
  const missing = order.totes - order.scanned;
  return (
    <section className="station-card st-panel" aria-label="Missing totes">
      <h2 className="st-panel-title">
        <span className="st-panel-icon" aria-hidden>
          <ShieldAlert size={22} strokeWidth={2.6} />
        </span>
        <span className="st-panel-kicker">MISSING TOTES</span>
        <span className="st-sr"> · </span>
        <span className="st-panel-sub">
          <span className="st-code">{order.number}</span> · {order.scanned} of {order.totes} scanned
        </span>
      </h2>
      <p className="st-panel-lead">
        {order.number} moves on to reconcile once every tote is scanned. Scan the missing{" "}
        {missing === 1 ? "tote" : "totes"}, or a manager approves finishing it with {order.scanned}{" "}
        of {order.totes}
        {blocked.next ? `; then ${blocked.next} opens.` : "."}
      </p>
      {editingReason ? (
        <form
          className="st-note"
          onSubmit={(e) => {
            e.preventDefault();
            on.editReason(false);
          }}
        >
          <label>
            Override reason
            <input autoFocus value={reason} onChange={(e) => on.reasonChange(e.target.value)} />
          </label>
          <button type="submit">Done</button>
        </form>
      ) : (
        <div className="st-note">
          {reason.trim() && <p className="st-note-text">Reason: {reason}</p>}
          <button
            type="button"
            className="st-btn-secondary"
            disabled={busy}
            onClick={() => on.editReason(true)}
          >
            <PenLine size={20} aria-hidden />
            {reason.trim() ? "Edit reason" : "Add reason"}
          </button>
        </div>
      )}
      <div>
        <button
          type="button"
          className="st-btn-hero st-btn-block"
          disabled={busy || why !== null || editingReason || short}
          onClick={on.approve}
        >
          <ShieldCheck size={26} aria-hidden />
          Approve incomplete totes and finish
        </button>
        <DisabledReason reason={why || (short && "Enter a reason first")} />
      </div>
    </section>
  );
}
