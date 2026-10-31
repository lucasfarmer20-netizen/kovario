"use client";
import { Fragment, useId, type ReactNode } from "react";
import {
  Check,
  CircleCheck,
  Inbox,
  KeyRound,
  ListChecks,
  Package,
  Printer,
  QrCode,
  Repeat2,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import { vesselReleaseAction } from "rules";
import { BasketRow } from "@/src/components/station/basket-row";
import { CountProgress } from "@/src/components/station/count-progress";
import { DisabledReason } from "@/src/components/station/next-step";
import { StationNotice } from "@/src/components/station/notice";
import { OrderTile } from "@/src/components/station/order-tile";
import type { EmptiedVessel, ReleaseReply } from "./boxing-data";
import {
  lbsValue,
  lineIssues,
  nothingLeft,
  vesselLabel,
  type I8Blocked,
  type Ticks,
  type Wizard,
  type WizardBox,
  type WizardVessel,
} from "./boxing-state";

/** A party in the boxing queue: "ALC-0001", "Pat Party · 2 of 3 boxes left". */
export type BoxingQueueItem = { id: string; number: string; detail: string };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The box's line as the crew reads it: "BOX-0001 · will-call · Medium · 20 lb". */
export function boxLabel(b: WizardBox) {
  const method = b.method === "willcall" ? "will-call" : b.method;
  const ship = b.method === "ship" ? ` · ships ${b.ship_date ?? "(no date)"}` : "";
  return `${b.number} · ${method} · ${b.size ?? "box"} · ${b.weight_lb} lb${ship}`;
}

/**
 * The boxing queue (docs/06 Boxing): priced parties with boxes still to hand over, oldest
 * first; tapping one opens it. `currentId` marks the party on screen.
 */
export function BoxingQueueCard({
  queue,
  currentId,
  disabled,
  onOpen,
}: {
  /** null while the first load is out. */
  queue: readonly BoxingQueueItem[] | null;
  currentId?: string;
  disabled?: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <section className="station-card" aria-label="Boxing queue">
      <h2 className="st-card-head">
        Ready to box {queue && <span className="st-count st-num">{queue.length}</span>}
      </h2>
      {!queue ? (
        <div className="st-skeleton-list" aria-hidden>
          <div className="st-skeleton" />
          <div className="st-skeleton" />
          <div className="st-skeleton" />
        </div>
      ) : queue.length === 0 ? (
        <div className="st-empty">
          <Inbox size={32} aria-hidden />
          <p>
            <strong>No priced party has boxes left to hand over.</strong>
            <br />
            Parties appear here when the counter prices them.
          </p>
        </div>
      ) : (
        <ul className="st-list">
          {queue.map((r) => (
            <li key={r.id}>
              <OrderTile
                number={r.number}
                detail={r.detail}
                current={r.id === currentId}
                disabled={disabled}
                onOpen={() => onOpen(r.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** /boxing: nothing open yet. What to scan, and the queue to tap instead. */
export function BoxingQueueView({
  queue,
  onOpen,
}: {
  queue: readonly BoxingQueueItem[] | null;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="st-floor bx-floor">
      <div className="st-main bx-work">
        <ScanReceipt title="No party open" />
      </div>
      <div className="st-rail bx-side">
        <BoxingQueueCard queue={queue} onOpen={onOpen} />
      </div>
    </div>
  );
}

function ScanReceipt({ title }: { title: string }) {
  return (
    <section className="station-card st-hero-empty bx-hero" aria-label="Open a party">
      <div className="st-hero-art" aria-hidden>
        <QrCode size={56} strokeWidth={1.6} />
      </div>
      <h2>{title}</h2>
      <p>Scan the boxing QR on the customer&apos;s receipt, or tap a party in Ready to box.</p>
    </section>
  );
}

export type ManagerToolsProps = {
  emptied: readonly EmptiedVessel[];
  tagForm: { tag: string; lbsLeft: string; reason: string };
  restoreReason: string;
  /** Starts open (gallery). */
  defaultOpen?: boolean;
  on: {
    tagForm: (form: { tag: string; lbsLeft: string; reason: string }) => void;
    restoreReason: (reason: string) => void;
    releaseByTag: () => void;
    restore: (vessel: EmptiedVessel) => void;
  };
};

export type BoxingPartyViewProps = {
  /** First load not back yet: placeholders in the final layout. */
  loading: boolean;
  /** The party could not be opened. */
  failed?: boolean;
  wizard: Wizard | null;
  ticks: Ticks;
  /** Stale-state notices from the last re-projection (I15). */
  notices: readonly string[];
  /** The last Complete's I8 refusal, as the server judged it. */
  blocked: I8Blocked;
  /** Why Complete waits; null when it can run. */
  why: string | null;
  reply: ReleaseReply | null;
  paymentRef: string;
  i8Reason: string;
  busy: boolean;
  queue: readonly BoxingQueueItem[] | null;
  tools: ManagerToolsProps;
  /** Focus handlers for text fields: the scanner pauses while one is being typed in. */
  field: { onFocus: () => void; onBlur: () => void };
  on: {
    toggleBox: (boxId: string) => void;
    tickBoxes: (boxIds: string[]) => void;
    toggleVessel: (vessel: WizardVessel) => void;
    lbsLeft: (vessel: WizardVessel, value: string) => void;
    paymentRef: (value: string) => void;
    i8Reason: (value: string) => void;
    complete: () => void;
    override: () => void;
    print: () => void;
    open: (sessionId: string) => void;
  };
};

/**
 * One party at boxing / will-call (docs/06-STATIONS-UX.md Boxing): the party and how much is
 * ticked, its boxes (by angler) and its pick list in walk order side by side, Complete under
 * them, and the notes and the queue in the rail. Box ticks and basket ticks are separate facts
 * (I1). Presentational: the live station and the gallery both render it.
 */
export function BoxingPartyView(props: BoxingPartyViewProps) {
  const { loading, failed, wizard, queue, on } = props;
  const side = (
    <div className="st-rail bx-side">
      {loading ? (
        <section className="station-card" aria-label="Notes">
          <h2 className="st-card-head">Notes</h2>
          <div className="st-skeleton-stack" aria-hidden>
            <div className="st-skeleton" style={{ height: 32, width: "60%" }} />
            <div className="st-skeleton" style={{ height: 72 }} />
          </div>
        </section>
      ) : (
        wizard && <NotesCard wizard={wizard} />
      )}
      <BoxingQueueCard
        queue={queue}
        currentId={wizard?.session_id}
        disabled={props.busy}
        onOpen={on.open}
      />
    </div>
  );
  if (loading || !wizard)
    return (
      <div className="st-floor bx-floor">
        <div className="st-main bx-work">
          {loading ? (
            <>
              <section className="station-card" aria-busy="true" aria-label="Opening party">
                <div className="st-skeleton-stack" aria-hidden>
                  <div className="st-skeleton" style={{ height: 56, width: "40%" }} />
                  <div className="st-skeleton" style={{ height: 96 }} />
                </div>
              </section>
              <section className="station-card" aria-hidden>
                <div className="st-skeleton-list">
                  <div className="st-skeleton" />
                </div>
              </section>
              <section className="station-card" aria-hidden>
                <div className="st-skeleton-list">
                  <div className="st-skeleton" />
                  <div className="st-skeleton" />
                  <div className="st-skeleton" />
                </div>
              </section>
            </>
          ) : (
            <ScanReceipt title={failed ? "Party not found" : "No party open"} />
          )}
        </div>
        {side}
      </div>
    );
  const done = nothingLeft(wizard);
  return (
    <div className="st-floor bx-floor">
      <div className="st-main bx-work">
        {props.blocked === "override" && !done && <OverridePanel {...props} />}
        {done ? (
          <HandedOver wizard={wizard} reply={props.reply} notices={props.notices} />
        ) : (
          <PartyCard {...props} />
        )}
        {!done && <BoxesCard {...props} />}
        {!done && <PickListCard {...props} />}
        {!done && <CommitArea {...props} />}
        <ManagerTools {...props.tools} field={props.field} />
      </div>
      {side}
    </div>
  );
}

function PartyCard({ wizard, ticks, notices, paymentRef, field, on }: BoxingPartyViewProps) {
  const heading = useId();
  const planned = new Set(wizard!.boxes.map((b) => b.box_id));
  const boxesTicked = ticks.boxes.filter((b) => planned.has(b)).length;
  const basketsTicked = wizard!.vessels.filter((v) => ticks.vessels[v.vessel_id]?.ticked).length;
  const boxesLeft = wizard!.boxes.length - boxesTicked;
  const basketsLeft = wizard!.vessels.length - basketsTicked;
  const left = [
    boxesLeft > 0 && plural(boxesLeft, "box", "boxes"),
    basketsLeft > 0 && plural(basketsLeft, "basket", "baskets"),
  ].filter(Boolean);
  return (
    <section className="station-card st-item bx-party" aria-labelledby={heading}>
      <div className="st-item-head">
        <div>
          <p className="st-eyebrow">Handing over</p>
          <h2 id={heading}>
            <span className="st-code">{wizard!.number}</span>
            <span className="st-sr"> · </span>
            <span className="bx-party-name">{wizard!.party_name ?? "Party"}</span>
          </h2>
        </div>
        <ul className="st-facts" aria-label="Party">
          <li>{plural(wizard!.boxes.length, "box", "boxes")} planned</li>
          <li>{plural(wizard!.vessels.length, "basket", "baskets")} in the freezer</li>
          {wizard!.finalized_count > 0 && (
            <li>{plural(wizard!.finalized_count, "box", "boxes")} already handed over</li>
          )}
        </ul>
      </div>
      {notices.map((n) => (
        <StationNotice key={n} tone="error" text={n} />
      ))}
      <CountProgress
        done={boxesTicked + basketsTicked}
        total={wizard!.boxes.length + wizard!.vessels.length}
        noun="ticked"
        label={left.length ? `${left.join(" and ")} not ticked` : "Everything ticked"}
      />
      <label className="bx-field bx-pay">
        Payment ref (receipt / register)
        <input value={paymentRef} onChange={(e) => on.paymentRef(e.target.value)} {...field} />
      </label>
    </section>
  );
}

/**
 * A whole-row tick target (≥ 72 px): the native checkbox covers the row, so the row is the
 * tap target and the checkbox keeps its name and checked state. Ticked reads by a frame, a
 * check and the word "Ticked".
 */
function TickRow({
  checked,
  label,
  onToggle,
  disabled,
  icon,
  name,
  meta,
  hint,
}: {
  checked: boolean;
  /** The checkbox's accessible name. */
  label: string;
  onToggle: () => void;
  disabled?: boolean;
  icon: ReactNode;
  name: ReactNode;
  meta: readonly ReactNode[];
  /** At the right edge while unticked: how to tick it ("Scan or tap"). */
  hint: string;
}) {
  return (
    <label className="st-basket-row bx-tick" data-checked={checked || undefined}>
      <input
        type="checkbox"
        className="bx-check"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
      />
      {icon}
      <span className="st-basket-row-main">
        <span className="st-basket-name">{name}</span>
        <span className="st-basket-row-meta">
          {meta.map((part, n) => (
            <Fragment key={n}>
              {n > 0 && " · "}
              <span className="st-basket-row-part">{part}</span>
            </Fragment>
          ))}
        </span>
      </span>
      <span className="st-basket-row-end">
        {checked ? (
          <span className="st-basket-flag">
            <Check size={16} strokeWidth={3.5} aria-hidden /> Ticked
          </span>
        ) : (
          <>
            <span className="bx-hint">{hint}</span>
            <span className="bx-box" aria-hidden />
          </>
        )}
      </span>
    </label>
  );
}

function BoxesCard({ wizard, ticks, busy, on }: BoxingPartyViewProps) {
  const w = wizard!;
  const ticked = new Set(ticks.boxes);
  const unticked = w.boxes.filter((b) => !ticked.has(b.box_id)).map((b) => b.box_id);
  const anglers = w.anglers.filter((a) => w.boxes.some((b) => b.settlement_id === a.settlement_id));
  const toteTicked = Object.values(ticks.vessels).some((l) => l.ticked);
  return (
    <section className="station-card bx-boxes" aria-label="Boxes">
      <h2 className="st-card-head">
        Boxes <span className="st-count st-num">{w.boxes.length}</span>
      </h2>
      {unticked.length > 1 && (
        <button
          type="button"
          className="st-btn-secondary st-btn-block bx-tick-all"
          disabled={busy}
          onClick={() => on.tickBoxes(unticked)}
        >
          <ListChecks size={22} aria-hidden />
          Tick every box
        </button>
      )}
      {w.boxes.length === 0 ? (
        <div className="st-empty">
          <Package size={32} aria-hidden />
          <p>
            <strong>No planned boxes left.</strong>
            <br />
            Boxes come from the counter&apos;s box plans.
          </p>
        </div>
      ) : (
        anglers.map((a) => (
          <div key={a.settlement_id} className="bx-group">
            <h3>{a.angler_name}</h3>
            <ul className="st-list">
              {w.boxes
                .filter((b) => b.settlement_id === a.settlement_id)
                .map((b) => (
                  <li key={b.box_id}>
                    <TickRow
                      checked={ticked.has(b.box_id)}
                      label={boxLabel(b)}
                      disabled={busy}
                      onToggle={() => on.toggleBox(b.box_id)}
                      icon={
                        <span className="st-basket-icon" aria-hidden>
                          <Package size={22} />
                        </span>
                      }
                      name={<span className="st-code">{b.number}</span>}
                      meta={[
                        b.method === "willcall" ? "will-call" : b.method,
                        b.size ?? "box",
                        `${b.weight_lb} lb`,
                        ...(b.method === "ship" ? [`ships ${b.ship_date ?? "(no date)"}`] : []),
                      ]}
                      hint="Tap"
                    />
                  </li>
                ))}
            </ul>
          </div>
        ))
      )}
      {ticks.boxes.length > 0 && !toteTicked && !w.moved_before && w.vessels.length > 0 && (
        <p className="st-expect bx-expect" role="status">
          No fish has moved for this party yet: tick the baskets you are handing over.
        </p>
      )}
    </section>
  );
}

function PickListCard({ wizard, ticks, blocked, busy, field, on }: BoxingPartyViewProps) {
  const w = wizard!;
  const issues = new Map(lineIssues(w, ticks).map((i) => [i.vesselId, i.message]));
  return (
    <section
      className="station-card bx-picklist"
      aria-label="Pick list"
      data-tone={blocked === "tote_left" ? "warn" : undefined}
    >
      <div className="st-card-head bx-picklist-head">
        <h2>
          Pick list · walk order <span className="st-count st-num">{w.vessels.length}</span>
        </h2>
        {w.vessels.length > 0 && (
          <button type="button" className="st-btn-secondary" onClick={on.print}>
            <Printer size={20} aria-hidden />
            Print pick list
          </button>
        )}
      </div>
      {w.vessels.length === 0 ? (
        <div className="st-empty">
          <Inbox size={32} aria-hidden />
          <p>
            <strong>No baskets left in the freezer for this party.</strong>
            <br />
            Tick the boxes being handed over, then Complete.
          </p>
        </div>
      ) : (
        <ol className="st-list bx-lines">
          {w.vessels.map((v, n) => {
            const l = ticks.vessels[v.vessel_id];
            const label = vesselLabel(v);
            const issue = issues.get(v.vessel_id);
            const isTicked = l?.ticked ?? false;
            const lbs = lbsValue(l?.lbsLeft ?? "");
            const action =
              isTicked && !issue ? vesselReleaseAction(true, lbs, v.weight_lb) : "none";
            return (
              <li key={v.vessel_id} className="bx-line" data-ticked={isTicked || undefined}>
                <TickRow
                  checked={isTicked}
                  label={`Tick ${label}`}
                  disabled={busy}
                  onToggle={() => on.toggleVessel(v)}
                  icon={
                    <span className="st-basket-icon bx-walk st-num" aria-hidden>
                      {n + 1}
                    </span>
                  }
                  name={
                    v.tag_code ? (
                      <>
                        Basket <span className="st-code">{v.tag_code}</span>
                      </>
                    ) : (
                      <>
                        <Repeat2 size={20} aria-hidden /> Exchange basket
                      </>
                    )
                  }
                  meta={[
                    <span key="loc" className="st-code bx-location">
                      {v.location_code ?? "unlocated"}
                    </span>,
                    ...(v.species_summary ? [v.species_summary] : []),
                    `${v.weight_lb} lb`,
                    v.intake_number,
                  ]}
                  hint={v.tag_code ? "Scan or tap" : "Tap"}
                />
                <label className="bx-left">
                  <span aria-hidden>Lbs left</span>
                  <input
                    inputMode="decimal"
                    aria-label={`Lbs left ${label}`}
                    aria-invalid={Boolean(issue)}
                    placeholder="0 = all"
                    value={l?.lbsLeft ?? ""}
                    disabled={busy}
                    onChange={(e) => on.lbsLeft(v, e.target.value)}
                    {...field}
                  />
                </label>
                {issue ? (
                  <p className="bx-issue">{issue}</p>
                ) : action === "split" ? (
                  <p className="bx-action">Split: {lbs} lb stays in the basket</p>
                ) : action === "full_pull" ? (
                  <p className="bx-action">Full pull: the basket empties</p>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/**
 * Complete, right under the pick list (it pins to the bottom of a phone once it can run), then
 * what the last Complete did.
 */
function CommitArea({ why, busy, blocked, reply, on }: BoxingPartyViewProps) {
  const ready = !busy && why === null && blocked === "none";
  return (
    <>
      <div
        className="bx-commit"
        data-ready={ready || undefined}
        data-tone={blocked !== "none" ? "warn" : undefined}
      >
        <button
          type="button"
          className="st-btn-hero st-btn-block"
          disabled={busy || why !== null}
          onClick={on.complete}
        >
          <Check size={26} strokeWidth={3} aria-hidden />
          Complete
        </button>
        <DisabledReason reason={why} />
      </div>
      {reply && (reply.stale.length > 0 || !reply.noop) && (
        <section className="station-card bx-result" aria-label="Complete result">
          <StaleNotice reply={reply} />
          {!reply.noop && <LastComplete reply={reply} />}
        </section>
      )}
    </>
  );
}

/** What the last Complete dropped because it was handled elsewhere (another station, I16). */
function StaleNotice({ reply }: { reply: ReleaseReply }) {
  if (reply.stale.length === 0) return null;
  return (
    <StationNotice
      tone="info"
      text={`Already handled elsewhere (dropped): ${reply.stale.map((s) => s.label).join(", ")}`}
    />
  );
}

/** What the last Complete did, line by line (finalised boxes, moved baskets, notices). */
function LastComplete({ reply }: { reply: ReleaseReply }) {
  return (
    <ul className="bx-last" aria-label="Last Complete">
      {reply.finalized.map((b) => (
        <li key={b.box_id}>
          <CircleCheck size={20} aria-hidden />
          {b.number} → {b.state.replace("_", " ")}
        </li>
      ))}
      {reply.moved.map((m) => (
        <li key={m.vessel_id}>
          <CircleCheck size={20} aria-hidden />
          {m.label} → {m.action === "split" ? `split, ${m.weight_left} lb left` : "emptied"}
        </li>
      ))}
      {reply.shipping.map((s) => (
        <li key={s.box_number}>{s.notice}</li>
      ))}
      {reply.closed_intakes.length > 0 && <li>Closed: {reply.closed_intakes.join(", ")}</li>}
    </ul>
  );
}

/**
 * Nothing left for this party. When it emptied under the operator (another station finalised
 * the last box or freed the last basket), the re-projection notices (I15) and the last
 * Complete's dropped lines still say which selections were handled elsewhere.
 */
function HandedOver({
  wizard,
  reply,
  notices,
}: {
  wizard: Wizard;
  reply: ReleaseReply | null;
  notices: readonly string[];
}) {
  const released = reply && !reply.noop;
  return (
    <section className="station-card st-hero-empty bx-hero bx-done" aria-label="Handed over">
      <div className="st-hero-art" aria-hidden>
        <CircleCheck size={56} strokeWidth={1.6} />
      </div>
      <h2>{released ? "All handed over" : "Nothing left to hand over"}</h2>
      <p>
        <span className="st-code">{wizard.number}</span> · {wizard.party_name ?? "Party"}. Scan the
        next receipt&apos;s boxing QR, or tap a party in Ready to box.
      </p>
      {(notices.length > 0 || (reply && reply.stale.length > 0)) && (
        <div className="bx-handled" aria-label="Handled elsewhere">
          {notices.map((n) => (
            <StationNotice key={n} tone="error" text={n} />
          ))}
          {reply && <StaleNotice reply={reply} />}
        </div>
      )}
      {released && <LastComplete reply={reply} />}
    </section>
  );
}

/**
 * DECISION-23: no basket is left for this party to tick, so a manager can finalise the ticked
 * boxes with a reason. Shown only when the server said so (the I8 hint), at the top of the work.
 */
function OverridePanel({ i8Reason, busy, field, on }: BoxingPartyViewProps) {
  const reason = i8Reason.trim();
  return (
    <section className="station-card st-panel bx-hold" aria-label="I8 override">
      <h3 className="st-panel-title">
        <span className="st-panel-icon" aria-hidden>
          <ShieldAlert size={22} strokeWidth={2.6} />
        </span>
        <span className="st-panel-kicker">MANAGER NEEDED</span>
        <span className="st-sr"> · </span>
        <span className="st-panel-sub">No basket left to tick</span>
      </h3>
      <p className="st-panel-lead">
        No basket is left to tick for this party: another party or a Release by tag took the last
        one. A manager can finalise the ticked boxes with a reason.
      </p>
      <label className="bx-field">
        Override reason
        <input value={i8Reason} onChange={(e) => on.i8Reason(e.target.value)} {...field} />
      </label>
      <div>
        <button
          type="button"
          className="st-btn-hero st-btn-block"
          disabled={busy || !reason}
          onClick={on.override}
        >
          <KeyRound size={24} aria-hidden />
          Manager override
        </button>
        <DisabledReason reason={!reason && "Enter a reason first"} />
      </div>
    </section>
  );
}

function NotesCard({ wizard }: { wizard: Wizard }) {
  return (
    <section className="station-card bx-notes" aria-label="Notes">
      <h2 className="st-card-head">Notes</h2>
      {wizard.intakes.length === 0 ? (
        <p className="station-hint">No orders on this party.</p>
      ) : (
        wizard.intakes.map((i) => {
          const flags = [
            i.dirty_fish && "DIRTY",
            i.ribbing && "RIBBING",
            i.smoking && "SMOKING SPLIT",
            i.other_sessions.length > 0 && `also in ${i.other_sessions.join(", ")}`,
          ].filter((f): f is string => Boolean(f));
          return (
            <div key={i.intake_id} className="bx-note">
              <h3>
                <span className="st-code">{i.number}</span> · {i.customer_name}
              </h3>
              {flags.length > 0 && (
                <p className="bx-flags">
                  {flags.map((f) => (
                    <span key={f} className="station-badge st-badge-flag">
                      {f}
                    </span>
                  ))}
                </p>
              )}
              {i.dirty_notes && <p>Dirty: {i.dirty_notes}</p>}
              {i.cut_notes && <p>Cut: {i.cut_notes}</p>}
              {i.processing_notes && <p>Processing: {i.processing_notes}</p>}
              <ul className="st-facts">
                {i.lines.map((ln, n) => (
                  <li key={n}>
                    {ln.species} · {ln.method} · {ln.lb} lb{ln.notes ? ` · ${ln.notes}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}

function ManagerTools({
  emptied,
  tagForm,
  restoreReason,
  defaultOpen,
  field,
  on,
}: ManagerToolsProps & { field: BoxingPartyViewProps["field"] }) {
  const tagWhy =
    (!tagForm.tag.trim() || !tagForm.reason.trim()) && "Enter the basket and a reason first";
  return (
    <details className="station-card bx-tools" open={defaultOpen || undefined}>
      <summary>
        <Wrench size={22} aria-hidden />
        Manager tools
      </summary>
      <div className="bx-tools-body">
        <section aria-label="Release by tag">
          <h3>Release by tag</h3>
          <p className="station-hint">
            For a basket that was not ticked at Complete. Baskets only.
          </p>
          <div className="bx-fields">
            <label className="bx-field">
              Basket to release
              <input
                value={tagForm.tag}
                onChange={(e) => on.tagForm({ ...tagForm, tag: e.target.value })}
                {...field}
              />
            </label>
            <label className="bx-field">
              Lbs left
              <input
                inputMode="decimal"
                placeholder="0 = all"
                value={tagForm.lbsLeft}
                onChange={(e) => on.tagForm({ ...tagForm, lbsLeft: e.target.value })}
                {...field}
              />
            </label>
            <label className="bx-field">
              Reason
              <input
                value={tagForm.reason}
                onChange={(e) => on.tagForm({ ...tagForm, reason: e.target.value })}
                {...field}
              />
            </label>
          </div>
          <button
            type="button"
            className="st-btn-secondary"
            disabled={Boolean(tagWhy)}
            onClick={on.releaseByTag}
          >
            <KeyRound size={20} aria-hidden />
            Release by tag
          </button>
          <DisabledReason reason={tagWhy} />
        </section>
        <section aria-label="Restore a released basket">
          <h3>Restore a released basket</h3>
          {emptied.length === 0 ? (
            <p className="station-hint">No released baskets for this party.</p>
          ) : (
            <>
              <label className="bx-field">
                Reason
                <input
                  value={restoreReason}
                  onChange={(e) => on.restoreReason(e.target.value)}
                  {...field}
                />
              </label>
              <ul className="st-list">
                {emptied.map((v) => (
                  <li key={v.id}>
                    <BasketRow
                      code={v.tag_code}
                      meta={[v.intake_number, `${v.weight_lb ?? "?"} lb`]}
                      end={
                        <button
                          type="button"
                          className="st-btn-secondary"
                          disabled={!restoreReason.trim()}
                          onClick={() => on.restore(v)}
                        >
                          Restore
                        </button>
                      }
                    />
                  </li>
                ))}
              </ul>
              <DisabledReason reason={!restoreReason.trim() && "Enter a reason first"} />
            </>
          )}
        </section>
      </div>
    </details>
  );
}
