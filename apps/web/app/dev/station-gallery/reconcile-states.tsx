"use client";
import type { ReactNode } from "react";
import { variancePercent, varianceBand, type VarianceBand } from "rules";
import { reconcileNextStep } from "@/components/reconcile/reconcile-station";
import {
  ReconcileView,
  type ReconcileBasket,
  type ReconcileViewProps,
} from "@/components/reconcile/reconcile-view";
import { VarianceHoldPanel } from "@/components/reconcile/variance-hold-panel";
import {
  SuspectPicker,
  type SuspectBinRow,
  type SuspectRow,
} from "@/components/reconcile/suspect-picker";
import { NowInBlastList, type NowInBlastLine } from "@/components/variance/now-in-blast";
import type { HoldMember } from "@/components/variance/use-variance-holds";
import { StationShell } from "@/src/components/station/station-shell";
import { FeedbackBanner, type FeedbackTone } from "@/src/components/station/scan-feedback";
import { StationNotice, type NoticeTone } from "@/src/components/station/notice";
import { OperatorPinOverlay } from "@/src/components/station/pin-overlay";
import type { ScaleState } from "@/src/components/station/scale-readout";

/** Static data for the gallery: no DB, no session; every handler is a no-op. */
const noop = () => undefined;
const LIMIT = 15;

const QUEUE = [
  {
    id: "o1",
    number: "INT-2141",
    held: false,
    detail: "Reds, Silvers · 40 lb expected",
    age: "6m",
  },
  { id: "o2", number: "INT-2142", held: true, detail: "Halibut · 62 lb expected", age: "18m" },
  { id: "o3", number: "INT-2143", held: true, detail: "Kings · 31 lb expected", age: "21m" },
  {
    id: "o4",
    number: "INT-2145",
    held: false,
    detail: "Lingcod, Rockfish · 24 lb expected",
    age: "34m",
  },
];
const ORDER = {
  id: "o1",
  number: "INT-2141",
  lines: [
    { species: "salmon_reds", lb: 26 },
    { species: "salmon_silvers", lb: 14 },
  ],
  expectedLb: 40,
};
const BLAST: NowInBlastLine[] = [
  {
    intake_id: "b1",
    intake_number: "INT-2138",
    variance_pct: 4,
    band: "within",
    limit_pct: LIMIT,
    rollstock_opened_at: null,
    rollstock_scan_id: null,
  },
  {
    intake_id: "b2",
    intake_number: "INT-2139",
    variance_pct: -11.5,
    band: "near",
    limit_pct: LIMIT,
    rollstock_opened_at: null,
    rollstock_scan_id: null,
  },
];
const basket = (id: string, code: string | null, weightLb: number, manual = false) => ({
  id,
  code,
  exchange: code === null,
  weightLb,
  manual,
});
const HOLD: HoldMember[] = [
  member("b2", "INT-2139", -1, -11.5, "near", "blast_freezer"),
  member("o1", "INT-2141", 0, 22, "over", "reconcile"),
  member("o2", "INT-2142", 1, -19, "over", "reconcile"),
  member("o3", "INT-2143", 2, 0, "unknown", "rollstock"),
];
function member(
  id: string,
  number: string,
  position: number,
  pct: number,
  band: string,
  state: string,
): HoldMember {
  return {
    hold_id: "h1",
    flagged_intake_id: "o1",
    intake_id: id,
    intake_number: number,
    position,
    state: state as HoldMember["state"],
    actual_lb: 0,
    variance_pct: pct,
    band,
    blocked: state === "reconcile",
    limit_pct: LIMIT,
    signed_off: false,
  };
}
const SUSPECTS: SuspectRow[] = [
  suspect("b2", "INT-2139", -1, "in_blast", "blast_freezer", 46, 52, ["salmon_reds"]),
  suspect("o1", "INT-2141", 0, "reconciled", "reconcile", 48.8, 40, [
    "salmon_reds",
    "salmon_silvers",
  ]),
  suspect("o2", "INT-2142", 1, "reconciled", "reconcile", 50.2, 62, ["whitefish_halibut"]),
  suspect("o3", "INT-2143", 2, "upstream", "rollstock", 0, 31, ["salmon_kings"]),
];
function suspect(
  id: string,
  number: string,
  position: number,
  status: string,
  state: string,
  actual: number,
  expected: number,
  species: string[],
): SuspectRow {
  const pct = variancePercent(actual, expected);
  return {
    center_intake_id: "o1",
    hold_id: "h1",
    intake_id: id,
    position,
    intake_number: number,
    state,
    status,
    waiting: status === "upstream",
    expected_lb: expected,
    actual_lb: actual,
    variance_pct: status === "upstream" ? null : pct,
    limit_pct: LIMIT,
    band: status === "upstream" ? "unknown" : varianceBand(actual, expected, LIMIT),
    species,
  };
}
const BINS: SuspectBinRow[] = [
  { id: "v1", intake_id: "o1", weight_lb: 22.4, is_exchange: false, asset_tag: { code: "042" } },
  { id: "v2", intake_id: "o1", weight_lb: 26.4, is_exchange: false, asset_tag: { code: "057" } },
  { id: "v3", intake_id: "o2", weight_lb: 50.2, is_exchange: true, asset_tag: null },
];

export type GalleryState = {
  id: string;
  title: string;
  /** What the state demonstrates. */
  note: string;
  loading?: boolean;
  queue?: typeof QUEUE;
  order?: typeof ORDER | null;
  baskets?: ReconcileBasket[];
  selected?: string | null;
  saving?: { id: string; lb: number } | null;
  scale?: { reading: number | null; state: ScaleState };
  manualWeightOpen?: string;
  basketFieldOpen?: boolean;
  feedback?: { tone: FeedbackTone; text: string };
  notice?: { tone: NoticeTone; text: string };
  operator?: string | null;
  pending?: number;
  online?: boolean;
  held?: boolean;
  suspects?: boolean;
  pin?: boolean;
};

const WEIGHING = [basket("v1", "042", 22.4), basket("v2", "057", 0), basket("v3", null, 0)];
const DONE_WITHIN = [basket("v1", "042", 22.4), basket("v2", "057", 17.1), basket("v3", null, 1.8)];
const DONE_OVER = [basket("v1", "042", 22.4), basket("v2", "057", 26.4)];

export const GALLERY_STATES: GalleryState[] = [
  {
    id: "loading",
    title: "Loading",
    note: "Placeholders hold the layout while the first load is out; nothing jumps when it lands.",
    loading: true,
  },
  {
    id: "pin",
    title: "PIN needed",
    note: "Operator PIN sheet on first touch: non-modal, the floor stays visible behind it.",
    order: null,
    operator: null,
    pin: true,
  },
  {
    id: "no-order",
    title: "No order open",
    note: "The queue with HELD orders and their age; the next step says scan or tap.",
    order: null,
  },
  {
    id: "empty-queue",
    title: "Queue empty",
    note: "Nothing at reconcile: an empty state that says where orders come from.",
    order: null,
    queue: [],
  },
  {
    id: "empty-order",
    title: "Order open, no baskets",
    note: "No verdict without data: expected only, every weight control says why it waits.",
    baskets: [],
    feedback: { tone: "ok", text: "Order INT-2141 opened" },
  },
  {
    id: "added",
    title: "Basket scanned",
    note: "Accept feedback in the scan tile; the new basket is selected and the scale is live.",
    baskets: [basket("v1", "042", 0)],
    selected: "v1",
    scale: { reading: 22.4, state: "stable" },
    feedback: { tone: "ok", text: "Basket 042 added to INT-2141" },
  },
  {
    id: "weighing",
    title: "Weighing (auto-advance)",
    note: "After Accept the next basket is selected; Accept waits for a new reading.",
    baskets: WEIGHING,
    selected: "v2",
    scale: { reading: 22.4, state: "used" },
    notice: { tone: "ok", text: "Basket 042 weighed: 22.4 lb" },
  },
  {
    id: "saving",
    title: "Saving a weight",
    note: "Optimistic: the weight lands on the basket in the same frame as the tap.",
    baskets: WEIGHING,
    selected: "v2",
    saving: { id: "v2", lb: 17.1 },
    scale: { reading: 17.1, state: "stable" },
  },
  {
    id: "scale-offline",
    title: "Scale offline",
    note: "No reading: Enter weight manually becomes the primary action.",
    baskets: WEIGHING,
    selected: "v2",
    scale: { reading: null, state: "none" },
  },
  {
    id: "manual-weight",
    title: "Manual weight",
    note: "Visible decimal field; the keyboard's Enter saves. The scanner pauses while it is open.",
    baskets: WEIGHING,
    selected: "v2",
    scale: { reading: null, state: "none" },
    manualWeightOpen: "17.1",
  },
  {
    id: "rejected",
    title: "Rejected scan",
    note: "Says why, then what to do; red, a cross and a shake, in the same tile as accepts.",
    baskets: WEIGHING,
    selected: "v2",
    scale: { reading: 22.4, state: "used" },
    feedback: {
      tone: "rejected",
      text: "Basket 005 is already on INT-2139. Scan a different basket.",
    },
  },
  {
    id: "typed-basket",
    title: "Enter manually (basket)",
    note: "The basket field opens in the order card, where the operator is already looking.",
    baskets: [basket("v1", "042", 22.4)],
    selected: "v1",
    basketFieldOpen: true,
    scale: { reading: 22.4, state: "used" },
  },
  {
    id: "ready",
    title: "Ready to send",
    note: "Every basket weighed, within the limit: Send to Blast is the one thing left.",
    baskets: DONE_WITHIN,
    selected: "v3",
    scale: { reading: 1.8, state: "used" },
  },
  {
    id: "over-limit",
    title: "Over the limit",
    note: "The meter, the band and the line warn before Send is pressed.",
    baskets: DONE_OVER,
    selected: "v2",
    scale: { reading: 26.4, state: "used" },
  },
  {
    id: "held",
    title: "Held",
    note: "The hold sits beside the order: the group in rollstock order, reasons, manager sign-off.",
    baskets: DONE_OVER,
    selected: "v2",
    scale: { reading: 26.4, state: "used" },
    held: true,
    notice: {
      tone: "error",
      text: "Send to Blast refused: INT-2141 is +22%, over the ±15% limit. Check weights or get a manager sign-off.",
    },
  },
  {
    id: "suspects",
    title: "Suspect picker",
    note: "Find the fish: the group most likely first, with moves and pull backs.",
    baskets: DONE_OVER,
    selected: "v2",
    scale: { reading: 26.4, state: "used" },
    held: true,
    suspects: true,
  },
  {
    id: "signed-off",
    title: "Signed off",
    note: "The hold clears; the reply confirms it and Send to Blast is live again.",
    baskets: DONE_WITHIN,
    selected: "v3",
    scale: { reading: 1.8, state: "used" },
    notice: { tone: "ok", text: "Hold signed off: Trim-heavy. INT-2141 can go to the blast." },
  },
  {
    id: "offline",
    title: "Offline · 3 pending",
    note: "Scans are kept on the tablet; controls that need the server wait, and say so.",
    baskets: WEIGHING,
    selected: "v2",
    scale: { reading: 17.1, state: "stable" },
    pending: 3,
    online: false,
    notice: {
      tone: "info",
      text: "Offline. Scans are saved on this tablet and send when the connection is back.",
    },
  },
];

function figures(baskets: readonly ReconcileBasket[]): {
  actual: number;
  pct: number | null;
  band: VarianceBand;
} {
  const actual = baskets.reduce((sum, b) => sum + b.weightLb, 0);
  return {
    actual,
    pct: variancePercent(actual, ORDER.expectedLb),
    band: varianceBand(actual, ORDER.expectedLb, LIMIT),
  };
}

/** A whole Reconcile screen in one gallery state, as the live station renders it. */
export function ReconcileScreen({ state }: { state: GalleryState }) {
  const order = state.order === undefined ? ORDER : state.order;
  const baskets = order ? (state.baskets ?? []) : [];
  const selected = state.selected ?? null;
  const { actual, pct, band } = figures(baskets);
  const empty = baskets.length === 0;
  const pending = state.pending ?? 0;
  const prompt = reconcileNextStep({
    open: order !== null,
    rows: baskets.map((b) => ({
      id: b.id,
      weight_lb: b.weightLb,
      is_exchange: b.exchange,
      asset_tag: b.code ? { code: b.code } : null,
    })),
    selected,
    variance: pct,
    over: band === "over",
    held: Boolean(state.held),
  });
  const pickWhy = empty ? "Add a basket first" : !selected ? "Tap a basket first" : null;
  const scale = state.scale ?? { reading: null, state: "none" as const };
  const scaleWhy =
    pickWhy ??
    (scale.state === "none"
      ? "No reading from the scale"
      : scale.state === "used"
        ? "Put the basket on the scale for a new reading"
        : null);
  const unweighed = baskets.some((b) => !(b.weightLb > 0));
  const sendWhy = empty ? "Add a basket first" : unweighed ? "Weigh every basket first" : null;
  const holdPanel: ReactNode =
    state.held && order ? (
      <VarianceHoldPanel
        group={HOLD}
        openIntakeId={order.id}
        disabled={false}
        editingNote={false}
        onEditNote={noop}
        onSignOff={noop}
        onFindSuspects={noop}
      />
    ) : null;
  const props: ReconcileViewProps = {
    loading: Boolean(state.loading),
    queue: state.queue ?? QUEUE,
    order,
    baskets,
    selected,
    saving: state.saving ?? null,
    variance: {
      actualLb: actual,
      pct,
      band,
      limitPct: LIMIT,
      refusal: band === "over" && !state.held,
      waiting: null,
    },
    scale,
    manualWeight: {
      open: state.manualWeightOpen !== undefined,
      value: state.manualWeightOpen ?? "",
    },
    why: { pick: pickWhy, scale: scaleWhy, send: sendWhy },
    disabled: pending > 0,
    basketField: { open: Boolean(state.basketFieldOpen), disabled: false, options: {} },
    holdPanel,
    suspectKey: null,
    suspectPicker: state.suspects ? (
      <SuspectPicker
        rows={SUSPECTS}
        bins={BINS}
        disabled={false}
        editingReason={false}
        onEditReason={noop}
        onMove={noop}
        onPullBack={noop}
        onClose={noop}
      />
    ) : null,
    blastList: <NowInBlastList lines={BLAST} onSelect={noop} />,
    on: {
      openOrder: noop,
      selectBasket: noop,
      basketField: noop,
      submitBasket: noop,
      addExchange: noop,
      accept: noop,
      manualWeight: noop,
      weightChange: noop,
      saveManual: noop,
      remove: noop,
      send: noop,
    },
  };
  const paused =
    Boolean(state.pin) || state.manualWeightOpen !== undefined || Boolean(state.basketFieldOpen);
  return (
    <StationShell
      name="Reconcile"
      site="Seward"
      operator={state.operator === undefined ? "Dana R." : state.operator}
      pending={pending}
      online={state.online}
      paused={paused}
      next={state.loading ? "Scan a tote or tap an order" : prompt.next}
      nextTone={prompt.tone}
      steps={["Add baskets", "Weigh", "Send to Blast"]}
      step={state.loading ? 0 : prompt.step}
      manualLabel="Tote number (INT-0002-1)"
      hideManual={order !== null && !state.loading}
      status={
        <>
          {state.feedback ? (
            <FeedbackBanner tone={state.feedback.tone} text={state.feedback.text} event={1} />
          ) : (
            <FeedbackBanner
              tone={paused ? "paused" : "idle"}
              text={paused ? "Scanner paused while a field is open" : "Scanner ready"}
            />
          )}
          <StationNotice text={state.notice?.text ?? ""} tone={state.notice?.tone} />
        </>
      }
      onScan={noop}
    >
      <ReconcileView {...props} />
      {state.pin && (
        <OperatorPinOverlay
          onClose={noop}
          verify={async () => ({ ok: false, reason: "Preview only" })}
        />
      )}
    </StationShell>
  );
}
