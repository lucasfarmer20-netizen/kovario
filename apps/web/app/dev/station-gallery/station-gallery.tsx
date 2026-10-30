"use client";
import { useState, type ReactNode } from "react";
import { Check, Package, Plus, Scale, ScanLine, Snowflake, Trash } from "lucide-react";
import { StationFrame, SyncBadge } from "@/src/components/station/station-shell";
import { NextStep } from "@/src/components/station/next-step";
import { ScanFeedback } from "@/src/components/station/scan-feedback";
import { ManualEntry } from "@/src/components/station/manual-entry";
import { ManagerPinOverlay, OperatorPinOverlay } from "@/src/components/station/pin-overlay";
import { StationButton } from "@/src/components/station/station-button";
import {
  CardHead,
  Skeleton,
  StationBadge,
  StationCard,
  StationEmpty,
  StationNotice,
} from "@/src/components/station/station-ui";
import { StationRow } from "@/src/components/station/station-row";
import { BandChip, VarianceMeter } from "@/src/components/station/variance-meter";
import { ScaleReadout, type ScaleState } from "@/src/components/station/scale-readout";
import { NowInBlastList } from "@/components/variance/now-in-blast";
import type { HoldMember } from "@/components/variance/use-variance-holds";
import {
  OrderCard,
  QueueCard,
  ReconcileDock,
  ReconcileSkeleton,
  STEPS,
  type OrderBasket,
  type QueueOrder,
} from "@/components/reconcile/order-card";
import { VarianceHoldPanel } from "@/components/reconcile/variance-hold-panel";
import {
  SuspectPicker,
  type SuspectBinRow,
  type SuspectRow,
} from "@/components/reconcile/suspect-picker";

const noop = () => undefined;
const never = async () => ({ ok: true });

// Static floor data -------------------------------------------------------------------------------
const QUEUE: QueueOrder[] = [
  {
    id: "i2",
    number: "INT-0002",
    meta: "Reds, Kings · 46 lb expected",
    held: false,
    open: true,
    age: null,
  },
  {
    id: "i3",
    number: "INT-0003",
    meta: "Halibut · 88 lb expected",
    held: true,
    open: false,
    age: "18m",
  },
  {
    id: "i4",
    number: "INT-0004",
    meta: "Silvers · 31 lb expected",
    held: false,
    open: false,
    age: "42m",
  },
  {
    id: "i5",
    number: "INT-0005",
    meta: "Reds · 22 lb expected",
    held: false,
    open: false,
    age: "1h",
  },
];
const QUEUE_CLOSED = QUEUE.map((o) => ({ ...o, open: false, age: o.age ?? "6m" }));
const BLAST = [
  {
    intake_id: "i1",
    intake_number: "INT-0001",
    variance_pct: 3,
    band: "within",
    limit_pct: 15,
    rollstock_opened_at: "2026-10-30T08:00:00+00:00",
    rollstock_scan_id: "s1",
  },
  {
    intake_id: "i0",
    intake_number: "INT-2120",
    variance_pct: 14,
    band: "near",
    limit_pct: 15,
    rollstock_opened_at: "2026-10-30T07:40:00+00:00",
    rollstock_scan_id: "s0",
  },
];
const LINES = [
  { species: "Reds", lb: 26 },
  { species: "Kings", lb: 20 },
];
const BASKETS: OrderBasket[] = [
  { id: "v1", name: "Basket 005", weightLb: 12.4, manual: false },
  { id: "v2", name: "Basket 006", weightLb: 0, manual: false },
  { id: "v3", name: "Exchange basket", weightLb: 0, manual: false },
];
const WEIGHED: OrderBasket[] = [
  { id: "v1", name: "Basket 005", weightLb: 12.4, manual: false },
  { id: "v2", name: "Basket 006", weightLb: 11.8, manual: true },
  { id: "v3", name: "Exchange basket", weightLb: 13.5, manual: false },
];
const SHORT: OrderBasket[] = [
  { id: "v1", name: "Basket 005", weightLb: 12.4, manual: false },
  { id: "v2", name: "Basket 006", weightLb: 11.8, manual: false },
  { id: "v3", name: "Exchange basket", weightLb: 13.5, manual: false },
];
const member = (
  n: number,
  position: number,
  pct: number,
  band: string,
  state: HoldMember["state"],
): HoldMember => ({
  hold_id: "h1",
  flagged_intake_id: "i2",
  intake_id: `i${n}`,
  intake_number: `INT-000${n}`,
  position,
  state,
  actual_lb: 0,
  variance_pct: pct,
  band,
  blocked: state === "reconcile",
  limit_pct: 15,
  signed_off: false,
});
const HOLD = [
  member(1, -1, 3, "within", "blast_freezer"),
  member(2, 0, -18, "over", "reconcile"),
  member(3, 1, 22, "over", "reconcile"),
  member(4, 2, 0, "unknown", "rollstock"),
];
const suspect = (
  n: number,
  position: number,
  status: string,
  actual: number,
  expected: number,
  species: string[],
): SuspectRow => {
  const pct = Math.round(((actual - expected) / expected) * 100);
  return {
    center_intake_id: "i2",
    hold_id: "h1",
    intake_id: `i${n}`,
    position,
    intake_number: `INT-000${n}`,
    state:
      status === "in_blast" ? "blast_freezer" : status === "upstream" ? "rollstock" : "reconcile",
    status,
    waiting: status === "upstream" || status === "at_reconcile",
    expected_lb: expected,
    actual_lb: actual,
    variance_pct: pct,
    limit_pct: 15,
    band: Math.abs(pct) > 15 ? "over" : Math.abs(pct) >= 10 ? "near" : "within",
    species,
  };
};
const SUSPECTS = [
  suspect(1, -1, "in_blast", 52, 50, ["Reds"]),
  suspect(2, 0, "reconciled", 37.7, 46, ["Reds", "Kings"]),
  suspect(3, 1, "reconciled", 107, 88, ["Halibut"]),
  suspect(4, 2, "reconciled", 31, 31, ["Silvers"]),
];
const BINS: SuspectBinRow[] = [
  { id: "v1", intake_id: "i2", weight_lb: 12.4, is_exchange: false, asset_tag: { code: "005" } },
  { id: "v2", intake_id: "i2", weight_lb: 11.8, is_exchange: false, asset_tag: { code: "006" } },
  { id: "b3", intake_id: "i3", weight_lb: 44, is_exchange: false, asset_tag: { code: "011" } },
  { id: "b4", intake_id: "i3", weight_lb: 63, is_exchange: true, asset_tag: null },
  { id: "b5", intake_id: "i4", weight_lb: 31, is_exchange: false, asset_tag: { code: "020" } },
];

// Helpers -----------------------------------------------------------------------------------------
function feedback(ok: boolean, reason: string, event = 1) {
  return { ok, reason, event };
}

/** An order card with sensible defaults for a static screen. */
function Order(props: Partial<Parameters<typeof OrderCard>[0]>) {
  const [typing, setTyping] = useState(false);
  const [form, setForm] = useState(false);
  const [value, setValue] = useState("");
  return (
    <OrderCard
      number="INT-0002"
      toteCount={2}
      lines={LINES}
      expected={46}
      baskets={BASKETS}
      selected="v2"
      lastAdded={null}
      variance={-73}
      band="over"
      limit={15}
      held={false}
      waiting={null}
      disabled={false}
      pickWhy={null}
      manualEntry={{
        open: typing,
        onOpenChange: setTyping,
        disabled: false,
        options: { orgSlug: "harbor" },
        onSubmit: noop,
      }}
      onSelect={noop}
      onExchange={noop}
      onRemove={noop}
      weightForm={{
        open: form,
        value,
        canSave: Number(value) > 0,
        onOpen: () => setForm(true),
        onChange: setValue,
        onSave: () => setForm(false),
        onCancel: () => setForm(false),
      }}
      {...props}
    />
  );
}

function Dock(props: Partial<Parameters<typeof ReconcileDock>[0]>) {
  return (
    <ReconcileDock
      scale={{ kind: "stable", weightLb: 11.8 }}
      acceptLabel="Accept 11.80 lb"
      acceptPrimary
      scaleWhy={null}
      sendWhy="Weigh every basket first"
      disabled={false}
      onAccept={noop}
      onSend={noop}
      {...props}
    />
  );
}

function Screen({
  next,
  step = 1,
  operator = "Dana K.",
  pending = 0,
  online = true,
  status,
  dock,
  manual,
  side = true,
  children,
}: {
  next: string;
  step?: number;
  operator?: string | null;
  pending?: number;
  online?: boolean;
  status?: ReactNode;
  dock?: ReactNode;
  manual?: ReactNode;
  side?: boolean;
  children: ReactNode;
}) {
  return (
    <StationFrame
      name="Reconcile"
      site="Harbor plant"
      operator={operator}
      pending={pending}
      online={online}
      next={next}
      steps={STEPS}
      step={step}
      manual={manual}
      status={status ?? <ScanFeedback feedback={null} />}
      dock={dock}
    >
      <div className="station-workspace">
        <div className="station-main">{children}</div>
        {side && (
          <div className="station-side">
            <QueueCard orders={QUEUE} title="4 waiting" disabled={false} onOpen={noop} />
            <NowInBlastList lines={BLAST} onSelect={noop} />
          </div>
        )}
      </div>
    </StationFrame>
  );
}

function Hold(props: { editing?: boolean }) {
  const [editing, setEditing] = useState(props.editing ?? false);
  return (
    <VarianceHoldPanel
      group={HOLD}
      openIntakeId="i2"
      disabled={false}
      editingNote={editing}
      onEditNote={setEditing}
      onSignOff={noop}
      onFindSuspects={noop}
    />
  );
}

function Picker() {
  const [editing, setEditing] = useState(false);
  return (
    <SuspectPicker
      rows={SUSPECTS}
      bins={BINS}
      disabled={false}
      editingReason={editing}
      onEditReason={setEditing}
      onMove={noop}
      onPullBack={noop}
      onClose={noop}
    />
  );
}

function ManualDemo({ label, placeholder }: { label: string; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <ManualEntry
      open={open}
      onOpenChange={setOpen}
      options={{ orgSlug: "harbor" }}
      label={label}
      placeholder={placeholder}
      onSubmit={noop}
    />
  );
}

// Composed screens: every state the brief lists ---------------------------------------------------
type ScreenSpec = { id: string; title: string; note: string; render: () => ReactNode };
const SCREENS: ScreenSpec[] = [
  {
    id: "no-order",
    title: "No order open",
    note: "The queue takes the work column. Scan a tote or tap an order; Enter manually sits under the prompt.",
    render: () => (
      <Screen
        next="Scan a tote or tap an order"
        step={0}
        side={false}
        manual={<ManualDemo label="Tote number (INT-0002-1)" placeholder="INT-0002-1" />}
      >
        <QueueCard
          orders={QUEUE_CLOSED}
          title="No order open"
          aside="4 waiting"
          disabled={false}
          onOpen={noop}
        />
        <NowInBlastList lines={BLAST} onSelect={noop} />
      </Screen>
    ),
  },
  {
    id: "loading",
    title: "Loading",
    note: "The real layout with placeholders where data lands, so nothing jumps when it arrives.",
    render: () => <ReconcileSkeleton />,
  },
  {
    id: "empty",
    title: "Empty · no baskets",
    note: "No verdict without data: expected weight only, no variance, band or warning. Every disabled button says why.",
    render: () => (
      <Screen
        next="Scan basket"
        step={0}
        dock={
          <Dock
            scale={{ kind: "waiting" }}
            acceptLabel="Accept scale weight"
            acceptPrimary={false}
            scaleWhy="Add a basket first"
            sendWhy="Add a basket first"
          />
        }
      >
        <Order
          baskets={[]}
          selected={null}
          pickWhy="Add a basket first"
          variance={null}
          band="unknown"
        />
      </Screen>
    ),
  },
  {
    id: "weighing",
    title: "Weighing · scale stable",
    note: "Basket 006 just scanned in and is selected; the dock shows the reading inside the Accept button. One tap per basket.",
    render: () => (
      <Screen
        next="Weigh basket 006"
        status={<ScanFeedback persist feedback={feedback(true, "Basket 006 added to INT-0002")} />}
        dock={<Dock />}
      >
        <Order lastAdded="v2" />
      </Screen>
    ),
  },
  {
    id: "stale",
    title: "Weighing · reading already used",
    note: "After Accept the selection moves to the next basket on its own, but the same reading is refused until the scale settles again.",
    render: () => (
      <Screen
        next="Weigh basket 006"
        status={<StationNotice tone="accent">Basket 005 weighed 12.40 lb</StationNotice>}
        dock={
          <Dock
            scale={{ kind: "stale", weightLb: 12.4 }}
            acceptLabel="Accept scale weight"
            scaleWhy="Put basket 006 on the scale, or enter its weight manually"
          />
        }
      >
        <Order />
      </Screen>
    ),
  },
  {
    id: "scale-offline",
    title: "Scale offline",
    note: "The readout says so in words and colour; Accept explains itself; Enter weight manually is the way through.",
    render: () => (
      <Screen
        next="Weigh basket 006"
        dock={
          <Dock
            scale={{ kind: "none" }}
            acceptLabel="Accept scale weight"
            scaleWhy="No scale on this station"
          />
        }
      >
        <Order />
      </Screen>
    ),
  },
  {
    id: "manual-weight",
    title: "Manual weight",
    note: "A decimal field opens in place under the selected basket; the scanner pauses while typing.",
    render: () => (
      <Screen
        next="Weigh basket 006"
        dock={
          <Dock
            scale={{ kind: "none" }}
            acceptLabel="Accept scale weight"
            scaleWhy="No scale on this station"
          />
        }
      >
        <ManualWeightOrder />
      </Screen>
    ),
  },
  {
    id: "rejected",
    title: "Rejected scan",
    note: "Red strip, double buzz, the reason and what to do next (docs/11 rule 4). The screen below does not move.",
    render: () => (
      <Screen
        next="Weigh basket 006"
        status={
          <ScanFeedback
            persist
            feedback={feedback(
              false,
              "Basket 007 is already on INT-0001. Scan a different basket.",
            )}
          />
        }
        dock={<Dock />}
      >
        <Order />
      </Screen>
    ),
  },
  {
    id: "within",
    title: "Every basket weighed · within limit",
    note: "Send takes over as the primary. The meter's mark sits inside the striped within-limit zone.",
    render: () => (
      <Screen
        next="Send to Blast"
        step={2}
        dock={
          <Dock
            acceptPrimary={false}
            sendWhy={null}
            scale={{ kind: "waiting" }}
            acceptLabel="Accept scale weight"
            scaleWhy="No reading from the scale"
          />
        }
      >
        <Order baskets={WEIGHED} selected={null} variance={-18.04 + 14} band="within" />
      </Screen>
    ),
  },
  {
    id: "over",
    title: "Over the limit",
    note: "Band chip in red with the stop shape and the word; the prompt says what happens if Send is pressed.",
    render: () => (
      <Screen
        next="Over the limit (−18%). Check weights before sending."
        step={2}
        dock={
          <Dock
            acceptPrimary={false}
            sendWhy={null}
            scale={{ kind: "waiting" }}
            acceptLabel="Accept scale weight"
            scaleWhy="No reading from the scale"
          />
        }
      >
        <Order baskets={SHORT} selected={null} variance={-18} band="over" />
      </Screen>
    ),
  },
  {
    id: "held",
    title: "Held · manager sign-off",
    note: "The order card is ringed; the hold panel lists the rollstock group with each member's band, then the reasons and the sign-off.",
    render: () => (
      <Screen
        next="Check weights or get a manager sign-off"
        step={2}
        dock={
          <Dock
            acceptPrimary={false}
            sendWhy={null}
            scale={{ kind: "waiting" }}
            acceptLabel="Accept scale weight"
            scaleWhy="No reading from the scale"
          />
        }
      >
        <Order baskets={SHORT} selected={null} variance={-18} band="over" held />
        <Hold />
      </Screen>
    ),
  },
  {
    id: "suspects",
    title: "Find the fish · suspect picker",
    note: "The group most likely first, suggested moves with one button each, and manual moves by tapping a basket then a destination.",
    render: () => (
      <Screen
        next="Check weights or get a manager sign-off"
        step={2}
        dock={
          <Dock
            acceptPrimary={false}
            sendWhy={null}
            scale={{ kind: "waiting" }}
            acceptLabel="Accept scale weight"
            scaleWhy="No reading from the scale"
          />
        }
      >
        <Order baskets={SHORT} selected={null} variance={-18} band="over" held />
        <Picker />
      </Screen>
    ),
  },
  {
    id: "signed-off",
    title: "Signed off",
    note: "The hold is cleared: a success notice where the eyes already are, and Send is live.",
    render: () => (
      <Screen
        next="Send to Blast"
        step={2}
        status={
          <>
            <ScanFeedback feedback={null} />
            <StationNotice tone="success">
              Hold signed off (estimate wrong) · Send to Blast is open
            </StationNotice>
          </>
        }
        dock={
          <Dock
            acceptPrimary={false}
            sendWhy={null}
            scale={{ kind: "waiting" }}
            acceptLabel="Accept scale weight"
            scaleWhy="No reading from the scale"
          />
        }
      >
        <Order baskets={SHORT} selected={null} variance={-18} band="over" />
      </Screen>
    ),
  },
  {
    id: "pin",
    title: "PIN needed",
    note: "A non-modal sheet (phone) or card (tablet) with a 64-px keypad; the scanner keeps working behind it and focus returns on close.",
    render: () => (
      <Screen next="Weigh basket 006" operator={null} dock={<Dock disabled scaleWhy={null} />}>
        <Order disabled />
        <OperatorPinOverlay verify={never} onClose={noop} />
      </Screen>
    ),
  },
  {
    id: "offline",
    title: "Offline · 2 pending",
    note: "The sync chip turns red; locally valid scans still get optimistic feedback and reconcile on reply.",
    render: () => (
      <Screen
        next="Weigh basket 006"
        online={false}
        pending={2}
        status={
          <ScanFeedback persist feedback={feedback(true, "Read locally — pending confirmation")} />
        }
        dock={<Dock disabled scaleWhy={null} />}
      >
        <Order disabled />
      </Screen>
    ),
  },
  {
    id: "sent",
    title: "Sent to blast",
    note: "The order leaves the queue, the success notice stays, and the prompt is back to the first step.",
    render: () => (
      <Screen
        next="Scan a tote or tap an order"
        step={0}
        side={false}
        status={
          <>
            <ScanFeedback feedback={null} />
            <StationNotice tone="success">
              INT-0002 sent to blast · 3 baskets · 37.70 lb
            </StationNotice>
          </>
        }
        manual={<ManualDemo label="Tote number (INT-0002-1)" placeholder="INT-0002-1" />}
      >
        <QueueCard
          orders={QUEUE_CLOSED.slice(1)}
          title="No order open"
          aside="3 waiting"
          disabled={false}
          onOpen={noop}
        />
        <NowInBlastList lines={BLAST} onSelect={noop} />
      </Screen>
    ),
  },
];

function ManualWeightOrder() {
  const [value, setValue] = useState("11.8");
  return (
    <OrderCard
      number="INT-0002"
      toteCount={2}
      lines={LINES}
      expected={46}
      baskets={BASKETS}
      selected="v2"
      lastAdded={null}
      variance={-73}
      band="over"
      limit={15}
      held={false}
      waiting={null}
      disabled={false}
      pickWhy={null}
      manualEntry={{
        open: false,
        onOpenChange: noop,
        disabled: true,
        options: { orgSlug: "harbor" },
        onSubmit: noop,
      }}
      onSelect={noop}
      onExchange={noop}
      onRemove={noop}
      weightForm={{
        open: true,
        value,
        canSave: Number(value) > 0,
        onOpen: noop,
        onChange: setValue,
        onSave: noop,
        onCancel: noop,
      }}
    />
  );
}

// The page ----------------------------------------------------------------------------------------
type Width = "phone" | "tablet" | "full";
const WIDTHS: Record<Width, number | string> = { phone: 400, tablet: 1280, full: "100%" };

function Item({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div className="gallery-item">
      <h3>{title}</h3>
      {note && <p>{note}</p>}
      {children}
    </div>
  );
}

function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`station gallery-panel ${className ?? ""}`}>{children}</div>;
}

const SWATCHES: [string, string][] = [
  ["--st-ink", "Ink"],
  ["--st-ink-2", "Ink 2"],
  ["--st-ink-3", "Ink 3"],
  ["--st-paper", "Paper"],
  ["--st-surface", "Surface"],
  ["--st-surface-2", "Surface 2"],
  ["--st-line", "Line"],
  ["--st-line-2", "Line 2"],
  ["--st-accent", "Accent"],
  ["--st-accent-soft", "Accent soft"],
  ["--st-within", "Within"],
  ["--st-within-bg", "Within bg"],
  ["--st-near", "Near"],
  ["--st-near-bg", "Near bg"],
  ["--st-over", "Over"],
  ["--st-over-bg", "Over bg"],
];

export function StationGallery() {
  const [width, setWidth] = useState<Width>("full");
  const scales: ScaleState[] = [
    { kind: "stable", weightLb: 12.4 },
    { kind: "stale", weightLb: 12.4 },
    { kind: "waiting" },
    { kind: "none" },
  ];
  return (
    <div className="gallery">
      <header className="gallery-bar">
        <h1>Station gallery · Reconcile</h1>
        <div className="gallery-toggle" role="group" aria-label="Frame width">
          {(["phone", "tablet", "full"] as Width[]).map((w) => (
            <button key={w} type="button" aria-pressed={width === w} onClick={() => setWidth(w)}>
              {w === "phone" ? "Phone 400" : w === "tablet" ? "Tablet 1280" : "Full width"}
            </button>
          ))}
        </div>
        <nav>
          <a href="#screens">Screens</a>
          <a href="#components">Components</a>
          <a href="#tokens">Tokens</a>
        </nav>
      </header>

      <h2 id="screens">Every state of the Reconcile station</h2>
      <p>
        Static props, no database. Switch the frame width to see the phone and tablet layouts; the
        station lays itself out from its own width, so these frames match the real screens.
      </p>
      {SCREENS.map((s) => (
        <div key={s.id} id={s.id} className="gallery-item" style={{ marginBottom: 40 }}>
          <h3>{s.title}</h3>
          <p>{s.note}</p>
          <div className="gallery-frame" style={{ width: WIDTHS[width] }}>
            {s.render()}
          </div>
        </div>
      ))}

      <h2 id="components">Components</h2>
      <p>Each shared station primitive in each of its states.</p>
      <div className="gallery-grid">
        <Item
          title="Next step line + step rail"
          note="The largest text on screen; done steps are ticked."
        >
          <Panel>
            <NextStep next="Scan basket" steps={STEPS} step={0} />
            <NextStep next="Weigh basket 006" steps={STEPS} step={1} />
            <NextStep next="Send to Blast" steps={STEPS} step={2} />
          </Panel>
        </Item>
        <Item
          title="Scan feedback"
          note="Accept and reject strips, icon + words; the idle strip keeps its height."
        >
          <Panel>
            <ScanFeedback persist feedback={feedback(true, "Basket 006 added to INT-0002")} />
            <ScanFeedback
              persist
              feedback={feedback(
                false,
                "Basket 007 is already on INT-0001. Scan a different basket.",
              )}
            />
            <ScanFeedback feedback={null} />
          </Panel>
        </Item>
        <Item
          title="Notices"
          note="What happened or what is in the way, where the eyes already are."
        >
          <Panel>
            <div className="station-status">
              <StationNotice>Refresh unavailable; check connection.</StationNotice>
              <StationNotice tone="accent">Basket 005 weighed 12.40 lb</StationNotice>
              <StationNotice tone="success">INT-0002 sent to blast</StationNotice>
              <StationNotice tone="warn" title="Scale offline">
                Weights can be entered manually; they are flagged in reports.
              </StationNotice>
              <StationNotice tone="danger" role="alert">
                Other needs a note
              </StationNotice>
            </div>
          </Panel>
        </Item>
        <Item
          title="Buttons"
          note="Tones by purpose, three sizes, and a disabled reason under the button."
        >
          <Panel>
            <div className="gallery-row">
              <StationButton tone="primary" icon={<Scale />}>
                Accept 12.40 lb
              </StationButton>
              <StationButton tone="send" icon={<Snowflake />}>
                Send to Blast Freezer
              </StationButton>
              <StationButton icon={<Plus />}>Add exchange basket</StationButton>
              <StationButton tone="ghost">Cancel manual weight</StationButton>
              <StationButton tone="danger" icon={<Trash />}>
                Remove selected basket
              </StationButton>
            </div>
            <div className="gallery-row" style={{ marginTop: 16 }}>
              <StationButton size="md" tone="primary">
                Medium 56
              </StationButton>
              <StationButton size="lg" tone="primary">
                Large 64
              </StationButton>
              <StationButton size="hero" tone="primary">
                Hero 80
              </StationButton>
            </div>
            <div className="gallery-row" style={{ marginTop: 16 }}>
              <StationButton tone="send" icon={<Snowflake />} why="Weigh every basket first">
                Send to Blast Freezer
              </StationButton>
              <StationButton tone="primary" icon={<Scale />} why="No reading from the scale">
                Accept scale weight
              </StationButton>
            </div>
          </Panel>
        </Item>
        <Item title="Badges and sync chip" note="Operator, sync state and list badges.">
          <Panel>
            <div className="gallery-row">
              <StationBadge tone="ink" chip>
                Dana K.
              </StationBadge>
              <StationBadge tone="warn" chip>
                Identify operator
              </StationBadge>
              <SyncBadge pending={0} online />
              <SyncBadge pending={2} online />
              <SyncBadge pending={2} online={false} />
            </div>
            <div className="gallery-row" style={{ marginTop: 16 }}>
              <StationBadge>Reds · 26 lb</StationBadge>
              <StationBadge tone="accent">Open</StationBadge>
              <StationBadge tone="quiet">42m</StationBadge>
              <StationBadge tone="danger">HELD</StationBadge>
              <StationBadge tone="warn">MANUAL WEIGHT</StationBadge>
              <StationBadge tone="ok">Weighed</StationBadge>
            </div>
          </Panel>
        </Item>
        <Item
          title="Rows"
          note="Baskets and queue orders: plain, selected (aria-pressed), open, disabled."
        >
          <Panel>
            <div className="station-rows">
              <StationRow
                lead={<Package />}
                title="Basket 006"
                trail={
                  <span className="station-row-figure station-row-figure-empty">Not weighed</span>
                }
              />
              <StationRow
                lead={<Package />}
                title="Basket 006"
                selected
                trail={
                  <span className="station-row-figure station-row-figure-empty">Not weighed</span>
                }
              />
              <StationRow
                lead={<Check />}
                leadTone="ok"
                title="Basket 005"
                trail={<span className="station-row-figure">12.4 lb</span>}
              />
              <StationRow
                lead={<Package />}
                title="INT-0002"
                meta="Reds, Kings · 46 lb expected"
                open
                trail={<StationBadge tone="accent">Open</StationBadge>}
              />
              <StationRow
                lead={<Package />}
                title="INT-0004"
                meta="Silvers · 31 lb expected"
                disabled
                trail={<StationBadge tone="quiet">42m</StationBadge>}
              />
            </div>
          </Panel>
        </Item>
        <Item
          title="Variance meter"
          note="Figures, the meter with the within-limit zone, and the band chip: colour, shape and word."
        >
          <Panel>
            <div style={{ display: "grid", gap: 24 }}>
              <VarianceMeter actual={47.2} expected={46} variance={2.6} band="within" limit={15} />
              <VarianceMeter actual={51.1} expected={46} variance={11.1} band="near" limit={15} />
              <VarianceMeter actual={37.7} expected={46} variance={-18} band="over" limit={15} />
              <VarianceMeter actual={37.7} expected={0} variance={null} band="unknown" limit={15} />
            </div>
          </Panel>
        </Item>
        <Item title="Band chips" note="Read without colour: tick, triangle, stop, dot.">
          <Panel>
            <div className="gallery-row">
              <BandChip band="within" limit={15} />
              <BandChip band="near" limit={15} />
              <BandChip band="over" limit={15} />
              <BandChip band="unknown" limit={15} />
            </div>
          </Panel>
        </Item>
        <Item title="Scale readout" note="Stable, already used, waiting, no scale.">
          <Panel>
            <div style={{ display: "grid", gap: 20 }}>
              {scales.map((s) => (
                <ScaleReadout key={s.kind} state={s} />
              ))}
            </div>
          </Panel>
        </Item>
        <Item title="Enter manually" note="Closed and open; the field names what is expected.">
          <Panel>
            <ManualDemo label="Basket number" placeholder="042" />
            <ManualEntry
              open
              onOpenChange={noop}
              options={{ orgSlug: "harbor" }}
              label="Tote number (INT-0002-1)"
              placeholder="INT-0002-1"
              onSubmit={noop}
            />
          </Panel>
        </Item>
        <Item title="Empty states and skeleton">
          <Panel>
            <StationEmpty
              icon={<ScanLine />}
              title="Scan basket to add it — or tap Enter manually."
            />
            <div style={{ height: 16 }} />
            <StationEmpty title="Queue empty">
              Orders arrive here as rollstock finishes them.
            </StationEmpty>
            <div style={{ height: 16 }} />
            <Skeleton height={28} width="40%" />
            <div style={{ height: 8 }} />
            <Skeleton height={64} />
          </Panel>
        </Item>
        <Item title="Card" note="Hairline, soft shadow, 20-px radius; a held card is ringed.">
          <Panel>
            <StationCard>
              <CardHead eyebrow="Reconcile queue" title="4 waiting" aside="FIFO" />
              <p className="station-meta">Card body</p>
            </StationCard>
            <div style={{ height: 16 }} />
            <StationCard held>
              <CardHead title="Order INT-0002" aside="2 totes · 3/3 weighed" />
              <p className="station-meta">Held with its rollstock neighbours</p>
            </StationCard>
          </Panel>
        </Item>
        <Item
          title="PIN overlays"
          note="Operator and manager; shown in place here, a sheet or card on the station."
        >
          <Panel className="gallery-static">
            <OperatorPinOverlay verify={never} onClose={noop} />
            <div style={{ height: 16 }} />
            <ManagerPinOverlay verify={never} onClose={noop} />
          </Panel>
        </Item>
        <Item title="Variance hold panel" note="With the note being typed.">
          <Panel>
            <Hold editing />
          </Panel>
        </Item>
      </div>

      <h2 id="tokens">Tokens</h2>
      <p>Defined on .station in app/station.css; every station inherits them.</p>
      <div className="gallery-grid">
        <Item title="Colour">
          <Panel>
            <div
              className="gallery-grid"
              style={{ gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}
            >
              {SWATCHES.map(([token, name]) => (
                <div key={token} className="gallery-swatch">
                  <span style={{ background: `var(${token})` }} />
                  <span>
                    <strong>{name}</strong>
                    <br />
                    <code>{token}</code>
                  </span>
                </div>
              ))}
            </div>
          </Panel>
        </Item>
        <Item
          title="Type scale"
          note="System UI stack; floor minimum 18 px; tabular figures for weights."
        >
          <Panel className="gallery-type">
            <p
              style={{
                fontSize: "var(--st-t-hero)",
                fontWeight: 800,
                letterSpacing: "-0.03em",
                lineHeight: 1.05,
              }}
            >
              Hero 38–58
            </p>
            <p
              style={{
                fontSize: "var(--st-t-figure)",
                fontWeight: 800,
                fontVariantNumeric: "tabular-nums",
                letterSpacing: "-0.03em",
                lineHeight: 1,
              }}
            >
              12.40 lb
            </p>
            <p style={{ fontSize: "var(--st-t-display)", fontWeight: 800 }}>Display 32</p>
            <p style={{ fontSize: "var(--st-t-title)", fontWeight: 750 }}>Title 26</p>
            <p style={{ fontSize: "var(--st-t-lead)", fontWeight: 700 }}>Lead 22</p>
            <p style={{ fontSize: "var(--st-t-body)", fontWeight: 600 }}>Body 20</p>
            <p style={{ fontSize: "var(--st-t-meta)", fontWeight: 650, color: "var(--st-ink-2)" }}>
              Meta 18 · the floor minimum
            </p>
          </Panel>
        </Item>
        <Item
          title="Spacing, radii, motion"
          note="4-px rhythm; 10 / 14 / 20 px radii; 120 / 180 / 300 ms, zeroed under prefers-reduced-motion."
        >
          <Panel>
            <div className="gallery-row">
              {[4, 8, 12, 16, 24, 32, 48].map((n) => (
                <span
                  key={n}
                  title={`${n}px`}
                  style={{ width: n, height: 24, background: "var(--st-accent)", borderRadius: 2 }}
                />
              ))}
            </div>
            <div className="gallery-row" style={{ marginTop: 16 }}>
              {[10, 14, 20].map((r) => (
                <span
                  key={r}
                  style={{
                    width: 64,
                    height: 64,
                    borderRadius: r,
                    border: "2px solid var(--st-ink)",
                  }}
                />
              ))}
            </div>
            <div className="gallery-row" style={{ marginTop: 16 }}>
              <span className="station-badge">--st-fast 120ms</span>
              <span className="station-badge">--st-base 180ms</span>
              <span className="station-badge">--st-slow 300ms</span>
            </div>
          </Panel>
        </Item>
      </div>
    </div>
  );
}
