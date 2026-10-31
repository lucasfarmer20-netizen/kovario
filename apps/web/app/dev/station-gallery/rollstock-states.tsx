"use client";
import {
  ROLLSTOCK_STEPS,
  RollstockView,
  rollstockNextStep,
  type RollstockBlock,
  type RollstockNextRow,
  type RollstockOrder,
  type RollstockResumeRow,
} from "@/components/rollstock/rollstock-view";
import { StationShell } from "@/src/components/station/station-shell";
import { Pin, Status, type ShellState } from "./freezer-states";

/** Static data for the gallery: no DB, no session; every handler is a no-op. */
const noop = () => undefined;
const OFFLINE = "Offline. Scans are saved on this tablet and send when the connection is back.";

export type RollstockState = ShellState & {
  order?: RollstockOrder | null;
  nextUp?: RollstockNextRow[];
  resume?: RollstockResumeRow[];
  blocked?: RollstockBlock | null;
  reason?: string;
  editingReason?: boolean;
  stale?: boolean;
};

const ORDER: RollstockOrder = {
  id: "i1",
  number: "INT-2141",
  species: ["Reds", "Silvers"],
  scanned: 1,
  totes: 3,
  flags: ["FAST PASS", "DIRTY"],
  notes: [
    { label: "Dirty fish", text: "Two silvers gut-shot, rinse well" },
    { label: "Cut", text: "Skin on, no belly strips" },
  ],
};
const PLAIN: RollstockOrder = {
  id: "i3",
  number: "INT-2143",
  species: ["Halibut"],
  scanned: 1,
  totes: 1,
  flags: [],
  notes: [],
};
const row = (id: string, number: string, detail: string, age: string): RollstockNextRow => ({
  id,
  number,
  detail,
  age,
});
const NEXT_UP = [
  row("i2", "INT-2142", "Lingcod, Rockfish · 2 totes · Processing", "6h since drop-off"),
  row("i4", "INT-2144", "Reds · 1 tote · Processing", "5h since drop-off"),
  row("i5", "INT-2146", "Kings · 3 totes · Cooler bypass", "2h since drop-off"),
];

export const ROLLSTOCK_STATES: RollstockState[] = [
  {
    id: "rollstock-loading",
    title: "Loading",
    note: "Placeholders in the shape of the open order and NEXT UP; nothing jumps when they land.",
    loading: true,
  },
  {
    id: "rollstock-pin",
    title: "Operator needed",
    note: "Identify operator in the console bar; the PIN sheet rises before the first scan counts.",
    operator: null,
    pin: true,
    nextUp: NEXT_UP,
  },
  {
    id: "rollstock-none",
    title: "No order open",
    note: "Step 1: scan a tote to open its order. Finish queue waits, and says why.",
    nextUp: NEXT_UP,
  },
  {
    id: "rollstock-empty-queue",
    title: "Queue empty",
    note: "Nothing open and nothing next up: says where orders come from.",
    nextUp: [],
  },
  {
    id: "rollstock-open",
    title: "Order open, totes to scan",
    note: "The hero: number and tote count, flags as badges, notes, one pip per tote. Step 1 ticks off. An order opens with its first tote, so this is Rollstock's nearest to an empty item.",
    order: ORDER,
    nextUp: NEXT_UP,
    feedback: { tone: "ok", text: "Tote accepted" },
  },
  {
    id: "rollstock-totes-in",
    title: "Every tote scanned",
    note: "The tally turns green and step 2 ticks off. Scanning the next order's tote moves this one on; Finish queue stays outlined.",
    order: { ...ORDER, scanned: 3 },
    nextUp: NEXT_UP,
    feedback: { tone: "ok", text: "Tote accepted" },
  },
  {
    id: "rollstock-finish",
    title: "Last order: Finish queue",
    note: "Every tote in and nothing next up: the next step is the tap, and Finish queue becomes the filled button.",
    order: PLAIN,
    nextUp: [],
    feedback: { tone: "ok", text: "Tote accepted" },
  },
  {
    id: "rollstock-rejected",
    title: "Rejected scan",
    note: "Says why, then what to do; red, a cross and a shake, in the same tile as accepts.",
    order: ORDER,
    nextUp: NEXT_UP,
    feedback: { tone: "rejected", text: "Tote not found. Scan a tote." },
  },
  {
    id: "rollstock-missing",
    title: "Missing totes: needs a manager",
    note: "A tote of the next order refused because INT-2141 still misses totes. The panel takes the top with the manager path; the next step line warns. Scanning the missing tote clears it.",
    order: { ...ORDER, scanned: 2 },
    nextUp: NEXT_UP,
    blocked: { next: "INT-2142" },
    feedback: { tone: "rejected", text: "Missing totes: 2 of 3 scanned" },
  },
  {
    id: "rollstock-reason",
    title: "Manager override: reason",
    note: "The reason is typed in an explicit editing mode: the scanner pauses, the keyboard's Enter is Done. Approve waits until it is done.",
    order: { ...ORDER, scanned: 2 },
    nextUp: NEXT_UP,
    blocked: { next: "INT-2142" },
    reason: "Tote 3 went to the wrong line",
    editingReason: true,
    feedback: { tone: "rejected", text: "Missing totes: 2 of 3 scanned" },
  },
  {
    id: "rollstock-done",
    title: "Sent to reconcile",
    note: "Green under the scan tile; the approved order's refused tote opened the next order in the same step.",
    order: { ...ORDER, id: "i2", number: "INT-2142", scanned: 1, totes: 2, flags: [], notes: [] },
    nextUp: NEXT_UP.slice(1),
    feedback: { tone: "ok", text: "Tote accepted" },
    notice: { tone: "ok", text: "Order INT-2141 sent to reconcile; INT-2142 is open" },
  },
  {
    id: "rollstock-manual",
    title: "Scanner down: Enter manually",
    note: "Rollstock has no scale or printer; with a dead scanner the tote number is typed (flagged manual). The scanner pauses while the field is open.",
    order: ORDER,
    nextUp: NEXT_UP,
    manual: true,
  },
  {
    id: "rollstock-offline",
    title: "Offline · 2 pending",
    note: "Scans wait on the tablet. Finish queue goes straight to the server, so it waits and says why.",
    order: { ...ORDER, scanned: 3 },
    nextUp: [],
    pending: 2,
    online: false,
    notice: { tone: "info", text: OFFLINE },
  },
  {
    id: "rollstock-stale",
    title: "Open order not found",
    note: "The order this tablet had open moved on elsewhere: Clear is the next step. Orders left open at another station can be resumed.",
    stale: true,
    nextUp: NEXT_UP,
    resume: [{ id: "i6", number: "INT-2140" }],
  },
];

/** A whole Rollstock screen in one gallery state, as the live station renders it. */
export function RollstockScreen({ state }: { state: RollstockState }) {
  const order = state.order ?? null;
  const nextUp = state.nextUp ?? [];
  const blocked = state.blocked ?? null;
  const prompt = rollstockNextStep(order, blocked, nextUp.length, state.stale);
  const paused = Boolean(state.pin || state.manual || state.editingReason);
  return (
    <StationShell
      name="Rollstock"
      site="Seward"
      operator={state.operator === undefined ? "Dana R." : state.operator}
      pending={state.pending ?? 0}
      online={state.online}
      paused={Boolean(state.pin || state.editingReason)}
      next={prompt.next}
      nextTone={prompt.tone}
      steps={ROLLSTOCK_STEPS}
      step={prompt.step}
      manualLabel="Tote number (INT-0002-1)"
      defaultManualOpen={state.manual}
      status={<Status state={state} paused={paused} />}
      onScan={noop}
    >
      <RollstockView
        loading={Boolean(state.loading)}
        order={order}
        stale={Boolean(state.stale)}
        nextUp={nextUp}
        resume={state.resume ?? []}
        blocked={blocked}
        reason={state.reason ?? ""}
        editingReason={Boolean(state.editingReason)}
        sending={state.pending ? "Waiting for scans to send" : null}
        online={state.online !== false}
        busy={Boolean(state.pin)}
        on={{
          finish: noop,
          resume: noop,
          clearStale: noop,
          editReason: noop,
          reasonChange: noop,
          approve: noop,
        }}
      />
      <Pin state={state} />
    </StationShell>
  );
}
