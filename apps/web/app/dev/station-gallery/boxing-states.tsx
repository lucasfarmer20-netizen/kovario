"use client";
import type { ReleaseReply } from "@/components/boxing/boxing-data";
import {
  BOXING_STEPS,
  boxingPrompt,
  completeWhy,
  emptyTicks,
  setLbsLeft,
  tickBoxes,
  toggleVessel,
  type I8Blocked,
  type Ticks,
  type Wizard,
} from "@/components/boxing/boxing-state";
import {
  BoxingPartyView,
  BoxingQueueView,
  type BoxingQueueItem,
} from "@/components/boxing/boxing-view";
import { StationShell } from "@/src/components/station/station-shell";
import { FeedbackBanner, type FeedbackTone } from "@/src/components/station/scan-feedback";
import { StationNotice, type NoticeTone } from "@/src/components/station/notice";
import { ManagerPinOverlay, OperatorPinOverlay } from "@/src/components/station/pin-overlay";

/** Static data for the gallery: no DB, no session; every handler is a no-op. */
const noop = () => undefined;
const OFFLINE = "Offline. Ticks stay on this tablet; Complete waits for the connection.";

const QUEUE: BoxingQueueItem[] = [
  { id: "s42", number: "ALC-0042", detail: "Rivera party · 3 of 3 boxes left" },
  { id: "s43", number: "ALC-0043", detail: "Okafor party · 2 of 2 boxes left" },
  { id: "s44", number: "ALC-0044", detail: "Lindqvist party · 1 of 4 boxes left" },
  { id: "s45", number: "ALC-0045", detail: "Party · 5 of 5 boxes left" },
];

const WIZARD: Wizard = {
  session_id: "s42",
  number: "ALC-0042",
  state: "priced",
  party_name: "Rivera party",
  moved_before: false,
  finalized_count: 0,
  anglers: [
    { settlement_id: "st1", number: "STL-0091", angler_name: "Ana Rivera", state: "draft" },
    { settlement_id: "st2", number: "STL-0092", angler_name: "Sam Rivera", state: "draft" },
  ],
  boxes: [
    {
      box_id: "b1",
      number: "BOX-0310",
      settlement_id: "st1",
      angler_name: "Ana Rivera",
      method: "willcall",
      size: "Medium",
      weight_lb: 20,
      shipment_number: null,
      ship_date: null,
    },
    {
      box_id: "b2",
      number: "BOX-0311",
      settlement_id: "st1",
      angler_name: "Ana Rivera",
      method: "willcall",
      size: "Large",
      weight_lb: 32,
      shipment_number: null,
      ship_date: null,
    },
    {
      box_id: "b3",
      number: "BOX-0312",
      settlement_id: "st2",
      angler_name: "Sam Rivera",
      method: "ship",
      size: "Medium",
      weight_lb: 18,
      shipment_number: "SHP-0021",
      ship_date: "2026-11-02",
    },
  ],
  vessels: [
    {
      vessel_id: "v1",
      intake_id: "i1",
      intake_number: "INT-2141",
      tag_code: "042",
      is_exchange: false,
      weight_lb: 30,
      species_summary: "Silvers",
      location_code: "IF-A-01-1-F",
      walk_seq: 1,
    },
    {
      vessel_id: "v2",
      intake_id: "i1",
      intake_number: "INT-2141",
      tag_code: "057",
      is_exchange: false,
      weight_lb: 24.5,
      species_summary: "Halibut",
      location_code: "IF-A-02-3-B",
      walk_seq: 2,
    },
    {
      vessel_id: "v3",
      intake_id: "i2",
      intake_number: "INT-2143",
      tag_code: null,
      is_exchange: true,
      weight_lb: 12,
      species_summary: "Kings",
      location_code: "IF-B-01-1-F",
      walk_seq: 3,
    },
  ],
  intakes: [
    {
      intake_id: "i1",
      number: "INT-2141",
      state: "stored",
      customer_name: "Ana Rivera",
      dirty_fish: true,
      dirty_notes: "sandy, rinse twice",
      cut_notes: "skin on, 1 in steaks",
      processing_notes: null,
      ribbing: true,
      smoking: false,
      lines: [
        { species: "Silvers", method: "Fillets", method_code: "fillets", lb: 42, notes: null },
        { species: "Halibut", method: "Steaks", method_code: "steaks", lb: 30, notes: "thick" },
      ],
      other_sessions: [],
    },
    {
      intake_id: "i2",
      number: "INT-2143",
      state: "stored",
      customer_name: "Sam Rivera",
      dirty_fish: false,
      dirty_notes: null,
      cut_notes: null,
      processing_notes: "half to the smoker",
      ribbing: false,
      smoking: true,
      lines: [{ species: "Kings", method: "Fillets", method_code: "fillets", lb: 18, notes: null }],
      other_sessions: ["ALC-0040"],
    },
  ],
};
const vessel = (id: string) => WIZARD.vessels.find((v) => v.vessel_id === id)!;
/** Ticks: the listed boxes, then each basket ticked with its Lbs left ("" = full pull). */
function ticked(boxes: string[], baskets: Array<[string, string]> = []): Ticks {
  let t = tickBoxes(emptyTicks(), boxes);
  for (const [id, left] of baskets) t = setLbsLeft(toggleVessel(t, vessel(id)), vessel(id), left);
  return t;
}
const SOME = ticked(["b1"], [["v1", "10"]]);
const ALL = ticked(
  ["b1", "b2", "b3"],
  [
    ["v1", ""],
    ["v2", ""],
    ["v3", ""],
  ],
);
const RELEASED: ReleaseReply = {
  ok: true,
  noop: false,
  session_number: "ALC-0042",
  session_state: "done",
  finalized: [
    { box_id: "b1", number: "BOX-0310", method: "willcall", state: "picked_up" },
    { box_id: "b2", number: "BOX-0311", method: "willcall", state: "picked_up" },
    { box_id: "b3", number: "BOX-0312", method: "ship", state: "packed" },
  ],
  moved: [
    { vessel_id: "v1", label: "Basket 042 (INT-2141)", action: "full_pull", weight_left: 0 },
    { vessel_id: "v2", label: "Basket 057 (INT-2141)", action: "full_pull", weight_left: 0 },
    { vessel_id: "v3", label: "Exchange basket (INT-2143)", action: "full_pull", weight_left: 0 },
  ],
  stale: [],
  closed_intakes: ["INT-2141", "INT-2143"],
  shipping: [{ box_number: "BOX-0312", notice: "BOX-0312 ships 2026-11-02 (SHP-0021)" }],
};

export type BoxingGalleryState = {
  id: string;
  title: string;
  /** What the state demonstrates. */
  note: string;
  /** The queue screen (/boxing), with nothing open. */
  queueScreen?: boolean;
  /** The party failed to load: the screen asks for a receipt instead. */
  failed?: boolean;
  loading?: boolean;
  queue?: BoxingQueueItem[];
  wizard?: Wizard;
  ticks?: Ticks;
  blocked?: I8Blocked;
  i8Reason?: string;
  reply?: ReleaseReply;
  notices?: string[];
  validating?: number;
  toolsOpen?: boolean;
  manualOpen?: boolean;
  feedback?: { tone: FeedbackTone; text: string };
  notice?: { tone: NoticeTone; text: string };
  operator?: string | null;
  pin?: boolean;
  managerPin?: boolean;
  pending?: number;
  online?: boolean;
};

const NO_BASKET_LEFT: Wizard = { ...WIZARD, vessels: [] };
const HANDED_OVER: Wizard = { ...WIZARD, boxes: [], vessels: [], finalized_count: 3 };

export const BOXING_GALLERY_STATES: BoxingGalleryState[] = [
  {
    id: "boxing-loading",
    title: "Loading",
    note: "Placeholders in the final layout (party, boxes, pick list; notes and queue in the rail); nothing jumps when it lands.",
    loading: true,
  },
  {
    id: "boxing-pin",
    title: "Operator needed",
    note: "Identify operator (salmon) and the PIN sheet; the party stays visible behind it.",
    operator: null,
    pin: true,
  },
  {
    id: "boxing-queue",
    title: "No party open",
    note: "What to scan (the receipt's boxing QR), and Ready to box beside it: one tap opens a party.",
    queueScreen: true,
  },
  {
    id: "boxing-empty-queue",
    title: "Queue empty",
    note: "No priced party has boxes left; the queue says parties come from the counter.",
    queueScreen: true,
    queue: [],
  },
  {
    id: "boxing-not-found",
    title: "Party not found",
    note: "The party did not load (a bad link, a network blip): says so, and the receipt's boxing QR, scanned or entered, opens it; the queue is beside it.",
    failed: true,
    notice: { tone: "error", text: "Party not found." },
  },
  {
    id: "boxing-open",
    title: "Party open, nothing ticked",
    note: "Boxes by angler and the pick list in walk order (location first). Complete says why it waits; Tick every box is one tap for a whole party.",
  },
  {
    id: "boxing-ticking",
    title: "Ticking",
    note: "Step 3 is current once anything is ticked. A scanned basket ticks its line; ticked rows are framed with Ticked; a split says what stays in the basket.",
    ticks: SOME,
    feedback: { tone: "ok", text: "Ticked Basket 042 (INT-2141)" },
  },
  {
    id: "boxing-ready",
    title: "Everything ticked",
    note: "The count turns green with a check; Complete is the one filled action (pinned to the bottom of a phone).",
    ticks: ALL,
    feedback: { tone: "ok", text: "Ticked Basket 057 (INT-2141)" },
  },
  {
    id: "boxing-manual",
    title: "Scanner down: Enter manually",
    note: "Boxing has no scale or printer (the pick list prints from the browser); with the scanner down, the basket number is typed. The exchange basket is ticked by tap either way.",
    ticks: SOME,
    manualOpen: true,
  },
  {
    id: "boxing-rejected",
    title: "Rejected scan",
    note: "Says why, then what to do; red, a cross and a shake, in the same tile as accepts. The list re-projects.",
    ticks: SOME,
    feedback: {
      tone: "rejected",
      text: "Basket 088 is not on ALC-0042's pick list; list refreshed",
    },
  },
  {
    id: "boxing-lbs-left",
    title: "Lbs left on an unticked line",
    note: "The fault shows on the line as it is typed (the rules engine's words), and Complete says to fix it first.",
    ticks: setLbsLeft(ticked(["b1"]), vessel("v2"), "5"),
  },
  {
    id: "boxing-tote-left",
    title: "Complete refused: baskets left",
    note: "I8: boxes ticked but no fish moved. The refusal leads the next step line in red, the pick list is framed red and Complete is restyled until a tick changes.",
    ticks: ticked(["b1", "b2"]),
    blocked: "tote_left",
    notice: {
      tone: "error",
      text: "no fish has moved for ALC-0042 yet: tick the baskets being handed over before finalising boxes (I8)",
    },
  },
  {
    id: "boxing-held",
    title: "Needs a manager",
    note: "I8 with no basket left to tick (DECISION-23): the override panel takes the top of the work, with a reason and the manager PIN sheet.",
    wizard: NO_BASKET_LEFT,
    ticks: ticked(["b1", "b2"]),
    blocked: "override",
    i8Reason: "Last basket went home with ALC-0040",
    managerPin: true,
    notice: {
      tone: "error",
      text: "no fish has moved for ALC-0042 yet: tick the baskets being handed over before finalising boxes, or ask a manager to override (I8)",
    },
  },
  {
    id: "boxing-done",
    title: "All handed over",
    note: "Green confirmation under the scan tile and what Complete did; scanning the next receipt opens the next party straight away, or tap one in the queue.",
    wizard: HANDED_OVER,
    queue: QUEUE.slice(1),
    reply: RELEASED,
    notice: { tone: "ok", text: "Released: 3 box(es), 3 tote(s)." },
  },
  {
    id: "boxing-emptied",
    title: "Handed over elsewhere",
    note: "Another station finalised the last box and freed the last basket: the party is empty, and the dropped ticks still say what was handled elsewhere.",
    wizard: { ...HANDED_OVER, finalized_count: 2 },
    queue: QUEUE.slice(1),
    notices: [
      "BOX-0310 is no longer planned (finalised elsewhere); its tick was dropped.",
      "Basket 042 (INT-2141) is no longer in the freezer (released elsewhere); dropped.",
    ],
    feedback: { tone: "ok", text: "ALC-0042 refreshed" },
  },
  {
    id: "boxing-offline",
    title: "Offline",
    note: "Ticks are local and keep working; Complete needs the server and says so.",
    ticks: ALL,
    online: false,
    pending: 1,
    notice: { tone: "info", text: OFFLINE },
  },
  {
    id: "boxing-tools",
    title: "Manager tools",
    note: "Release by tag and restore a released basket, under the work; closed by default. Each button says why it waits.",
    toolsOpen: true,
  },
];

/** The Boxing screen for a gallery state id, or null when the id is another station's. */
export function BoxingGalleryScreen({ id }: { id: string }) {
  const state = BOXING_GALLERY_STATES.find((s) => s.id === id);
  return state ? <BoxingScreen state={state} /> : null;
}

/** A whole Boxing screen in one gallery state, as the live station renders it. */
export function BoxingScreen({ state }: { state: BoxingGalleryState }) {
  const wizard = state.loading || state.failed ? null : (state.wizard ?? WIZARD);
  const ticks = state.ticks ?? emptyTicks();
  const blocked = state.blocked ?? "none";
  const online = state.online ?? true;
  const prompt = boxingPrompt(state.queueScreen ? null : wizard, ticks, blocked);
  const paused = Boolean(state.pin || state.managerPin || state.manualOpen);
  const done = wizard !== null && wizard.boxes.length === 0 && wizard.vessels.length === 0;
  return (
    <StationShell
      name="Boxing / will-call"
      site="Seward"
      operator={state.operator === undefined ? "Dana R." : state.operator}
      pending={state.pending ?? 0}
      online={state.online}
      paused={Boolean(state.pin || state.managerPin)}
      next={prompt.next}
      nextTone={prompt.tone}
      steps={BOXING_STEPS}
      step={state.loading ? 1 : prompt.step}
      manualLabel={
        state.queueScreen || state.failed || done ? "Boxing code (on the receipt)" : "Basket number"
      }
      defaultManualOpen={state.manualOpen}
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
      {state.queueScreen ? (
        <BoxingQueueView queue={state.queue ?? QUEUE} onOpen={noop} />
      ) : (
        <BoxingPartyView
          loading={Boolean(state.loading)}
          failed={state.failed}
          wizard={wizard}
          ticks={ticks}
          notices={state.notices ?? []}
          blocked={blocked}
          why={
            wizard
              ? completeWhy({ wizard, ticks, validating: state.validating ?? 0, online })
              : null
          }
          reply={state.reply ?? null}
          paymentRef={state.reply ? "" : "R-10422"}
          i8Reason={state.i8Reason ?? ""}
          busy={false}
          queue={state.queue ?? QUEUE}
          field={{ onFocus: noop, onBlur: noop }}
          tools={{
            emptied: state.toolsOpen
              ? [
                  {
                    id: "e1",
                    intake_number: "INT-2138",
                    tag_code: "019",
                    weight_lb: 26.5,
                    emptied_at: null,
                  },
                ]
              : [],
            tagForm: { tag: "", lbsLeft: "", reason: "" },
            restoreReason: "",
            defaultOpen: state.toolsOpen,
            on: { tagForm: noop, restoreReason: noop, releaseByTag: noop, restore: noop },
          }}
          on={{
            toggleBox: noop,
            tickBoxes: noop,
            toggleVessel: noop,
            lbsLeft: noop,
            paymentRef: noop,
            i8Reason: noop,
            complete: noop,
            override: noop,
            print: noop,
            open: noop,
          }}
        />
      )}
      {state.pin && (
        <OperatorPinOverlay
          onClose={noop}
          verify={async () => ({ ok: false, reason: "Preview only" })}
        />
      )}
      {state.managerPin && (
        <ManagerPinOverlay
          onClose={noop}
          verify={async () => ({ ok: false, reason: "Preview only" })}
        />
      )}
    </StationShell>
  );
}
