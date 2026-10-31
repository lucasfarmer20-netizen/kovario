"use client";
import {
  BlastView,
  blastNextStep,
  type BlastInRow,
  type BlastWaitingRow,
} from "@/components/freezer/blast-view";
import {
  LOCATE_STEPS,
  LocateView,
  locateNextStep,
  type LocateBasket,
  type LocateExchangeRow,
} from "@/components/freezer/locate-view";
import { NowInBlastList, type NowInBlastLine } from "@/components/variance/now-in-blast";
import { StationShell } from "@/src/components/station/station-shell";
import { FeedbackBanner, type FeedbackTone } from "@/src/components/station/scan-feedback";
import { StationNotice, type NoticeTone } from "@/src/components/station/notice";
import { OperatorPinOverlay } from "@/src/components/station/pin-overlay";

/** Static data for the gallery: no DB, no session; every handler is a no-op. */
const noop = () => undefined;
const LIMIT = 15;
const OFFLINE = "Offline. Scans are saved on this tablet and send when the connection is back.";

/** What every Blast / Locate (and Rollstock) gallery state shares: the shell around the view. */
export type ShellState = {
  id: string;
  title: string;
  /** What the state demonstrates. */
  note: string;
  loading?: boolean;
  feedback?: { tone: FeedbackTone; text: string };
  notice?: { tone: NoticeTone; text: string };
  operator?: string | null;
  pin?: boolean;
  pending?: number;
  online?: boolean;
  /** Enter manually open: the scanner is down. */
  manual?: boolean;
};
export type BlastState = ShellState & {
  waiting?: BlastWaitingRow[];
  inBlast?: BlastInRow[];
  blasting?: string[];
  lines?: NowInBlastLine[];
};
export type LocateState = ShellState & {
  basket?: LocateBasket | null;
  exchange?: LocateExchangeRow[];
  selecting?: string | null;
};

const line = (number: string, pct: number | null, band: string): NowInBlastLine => ({
  intake_id: number,
  intake_number: number,
  variance_pct: pct,
  band,
  limit_pct: LIMIT,
  rollstock_opened_at: null,
  rollstock_scan_id: null,
});
const LINES = [
  line("INT-2138", 4, "within"),
  line("INT-2139", 11.5, "near"),
  line("INT-2141", -2.1, "within"),
];
const waiting = (id: string, code: string | null, order: string, lb: number, age: string) => ({
  id,
  code,
  order,
  weightLb: lb,
  waiting: age,
});
const inBlast = (id: string, code: string | null, order: string, lb: number, time: string) => ({
  id,
  code,
  order,
  weightLb: lb,
  timeIn: time,
});
const WAITING = [
  waiting("w1", "042", "INT-2141", 22.4, "0h 12m"),
  waiting("w2", "057", "INT-2141", 17.1, "0h 12m"),
  waiting("w3", null, "INT-2141", 1.8, "0h 12m"),
];
const IN_BLAST = [
  inBlast("b1", "005", "INT-2138", 31.2, "3h 40m"),
  inBlast("b2", null, "INT-2138", 4.6, "3h 38m"),
  inBlast("b3", "018", "INT-2139", 26.5, "1h 05m"),
];

export const BLAST_STATES: BlastState[] = [
  {
    id: "blast-loading",
    title: "Loading",
    note: "Placeholders in the final layout: both lists and the rail; nothing jumps when they land.",
    loading: true,
  },
  {
    id: "blast-pin",
    title: "Operator needed",
    note: "Identify operator in the console bar; the PIN sheet rises on the first scan or tap.",
    operator: null,
    pin: true,
    waiting: WAITING,
    inBlast: IN_BLAST,
    lines: LINES,
  },
  {
    id: "blast-empty",
    title: "Blast freezer empty",
    note: "Nothing waiting, nothing in: says where baskets come from.",
    waiting: [],
    inBlast: [],
    lines: [],
  },
  {
    id: "blast-waiting",
    title: "Baskets waiting",
    note: "Oldest release first. A tagged basket says Scan; an exchange basket has Blast in, outlined while scanning leads.",
    waiting: WAITING,
    inBlast: IN_BLAST,
    lines: LINES,
  },
  {
    id: "blast-exchange",
    title: "Only exchange baskets waiting",
    note: "Nothing to scan: the next step is the tap, and Blast in becomes the filled button.",
    waiting: [WAITING[2]!],
    inBlast: IN_BLAST,
    lines: LINES,
  },
  {
    id: "blast-saving",
    title: "Blast in sent",
    note: "Optimistic: the tapped row turns to a spinner in the same frame and leaves when the refresh confirms it.",
    waiting: [WAITING[2]!],
    inBlast: IN_BLAST,
    blasting: ["w3"],
    lines: LINES,
    feedback: { tone: "ok", text: "Sent — pending confirmation" },
  },
  {
    id: "blast-done",
    title: "Basket in blast",
    note: "Green in the scan tile; the basket enters In blast. Nothing waiting says so.",
    waiting: [],
    inBlast: [...IN_BLAST, inBlast("b4", "057", "INT-2141", 17.1, "0h 00m")],
    lines: LINES,
    feedback: { tone: "ok", text: "Basket 057 in blast · INT-2141" },
  },
  {
    id: "blast-rejected",
    title: "Rejected scan",
    note: "Says why, then what to do; red, a cross and a shake, in the same tile as accepts.",
    waiting: WAITING,
    inBlast: IN_BLAST,
    lines: LINES,
    feedback: {
      tone: "rejected",
      text: "Order INT-2144 has not been sent to blast. Scan a different basket.",
    },
  },
  {
    id: "blast-over-limit",
    title: "Over the limit in the blast",
    note: "Each order's band is colour + shape + words with its meter. Informational at Blast: nothing here is blocked, and a held order never reaches it (Send to Blast is refused).",
    waiting: WAITING,
    inBlast: IN_BLAST,
    lines: [line("INT-2136", 22, "over"), ...LINES, line("INT-2142", null, "unknown")],
  },
  {
    id: "blast-manual",
    title: "Scanner down: Enter manually",
    note: "Blast has no scale or printer; with a dead scanner the basket number is typed (flagged manual). The scanner pauses while the field is open.",
    waiting: WAITING,
    inBlast: IN_BLAST,
    lines: LINES,
    manual: true,
  },
  {
    id: "blast-offline",
    title: "Offline · 2 pending",
    note: "Scans and Blast in taps are kept on the tablet and sent when the connection is back; the tapped row keeps its spinner until then.",
    waiting: [WAITING[0]!, WAITING[2]!],
    inBlast: IN_BLAST,
    blasting: ["w3"],
    lines: LINES,
    pending: 2,
    online: false,
    notice: { tone: "info", text: OFFLINE },
  },
];

const BASKET: LocateBasket = {
  id: "v1",
  code: "042",
  exchange: false,
  order: "INT-2141",
  species: "Reds, Silvers",
};
const EXCHANGE: LocateExchangeRow[] = [
  { id: "x1", order: "INT-2138", weightLb: 4.6, blast: "in blast 3h 38m" },
  { id: "x2", order: "INT-2141", weightLb: 1.8, blast: "not blasted in" },
];
const EXCHANGE_BASKET: LocateBasket = {
  id: "x1",
  code: null,
  exchange: true,
  order: "INT-2138",
  species: "Reds",
};

export const LOCATE_STATES: LocateState[] = [
  {
    id: "locate-loading",
    title: "Loading",
    note: "A placeholder in the step card's place while the first load is out.",
    loading: true,
  },
  {
    id: "locate-pin",
    title: "Operator needed",
    note: "Identify operator in the console bar; the PIN sheet rises on the first scan or tap.",
    operator: null,
    pin: true,
  },
  {
    id: "locate-start",
    title: "No basket scanned",
    note: "Step 1: what to scan, then what comes after it.",
  },
  {
    id: "locate-exchange",
    title: "Exchange baskets waiting",
    note: "Exchange baskets have no tag: each row is one tap target, the alternative to the scan.",
    exchange: EXCHANGE,
  },
  {
    id: "locate-basket",
    title: "Basket scanned",
    note: "Step 1 ticks off. The basket, its order and species; the card says the location it waits for. Another basket scan replaces it.",
    basket: BASKET,
    feedback: { tone: "ok", text: "Basket 042 · INT-2141. Scan a location." },
  },
  {
    id: "locate-exchange-selected",
    title: "Exchange basket selected",
    note: "The chosen row is framed and says Selected; the list stays, so another basket is one tap.",
    basket: EXCHANGE_BASKET,
    exchange: EXCHANGE,
    feedback: { tone: "ok", text: "Exchange basket · INT-2138. Scan a location." },
  },
  {
    id: "locate-placed",
    title: "Placed",
    note: "Green in the scan tile; both steps reset for the next basket.",
    exchange: EXCHANGE.slice(1),
    feedback: { tone: "ok", text: "Basket 042 placed at IF-A-01-1-F" },
  },
  {
    id: "locate-rejected",
    title: "Rejected location",
    note: "The server's reason in the red tile; the basket stays scanned, so only the location is scanned again.",
    basket: BASKET,
    feedback: {
      tone: "rejected",
      text: "location IF-A-02-2-R is archived and cannot be bound",
    },
  },
  {
    id: "locate-manual",
    title: "Scanner down: Enter manually",
    note: "No scale or printer here; a dead scanner means typing. In step 2 the field asks for the location.",
    basket: BASKET,
    manual: true,
  },
  {
    id: "locate-offline",
    title: "Offline · 2 pending",
    note: "Scans wait on the tablet. Taps that pick a basket need the replies first, so they wait and say why.",
    basket: BASKET,
    exchange: EXCHANGE,
    selecting: null,
    pending: 2,
    online: false,
    notice: { tone: "info", text: OFFLINE },
  },
];

/** The shell's status column: a scan result, or whether the scanner is listening. */
export function Status({ state, paused }: { state: ShellState; paused: boolean }) {
  return (
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
  );
}

export function Pin({ state }: { state: ShellState }) {
  return state.pin ? (
    <OperatorPinOverlay
      onClose={noop}
      verify={async () => ({ ok: false, reason: "Preview only" })}
    />
  ) : null;
}

/** A whole Blast screen in one gallery state, as the live station renders it. */
export function BlastScreen({ state }: { state: BlastState }) {
  const rows = state.waiting ?? [];
  const paused = Boolean(state.pin || state.manual);
  return (
    <StationShell
      name="Blast"
      site="Seward"
      operator={state.operator === undefined ? "Dana R." : state.operator}
      pending={state.pending ?? 0}
      online={state.online}
      paused={Boolean(state.pin)}
      next={blastNextStep(rows)}
      manualLabel="Basket number"
      defaultManualOpen={state.manual}
      status={<Status state={state} paused={paused} />}
      onScan={noop}
    >
      <BlastView
        loading={Boolean(state.loading)}
        waiting={rows}
        inBlast={state.inBlast ?? []}
        blasting={state.blasting ?? []}
        blastList={<NowInBlastList lines={state.lines ?? []} meter />}
        on={{ blastIn: noop }}
      />
      <Pin state={state} />
    </StationShell>
  );
}

/** A whole Locate screen in one gallery state, as the live station renders it. */
export function LocateScreen({ state }: { state: LocateState }) {
  const basket = state.basket ?? null;
  const exchange = state.exchange ?? [];
  const prompt = locateNextStep(basket, exchange.length);
  const paused = Boolean(state.pin || state.manual);
  return (
    <StationShell
      name="Locate"
      site="Seward"
      operator={state.operator === undefined ? "Dana R." : state.operator}
      pending={state.pending ?? 0}
      online={state.online}
      paused={Boolean(state.pin)}
      next={state.loading ? "Scan basket" : prompt.next}
      steps={LOCATE_STEPS}
      step={state.loading ? 0 : prompt.step}
      manualLabel={basket ? "Location (IF-A-01-1-F)" : "Basket number"}
      defaultManualOpen={state.manual}
      status={<Status state={state} paused={paused} />}
      onScan={noop}
    >
      <LocateView
        loading={Boolean(state.loading)}
        basket={basket}
        exchange={exchange}
        selecting={state.selecting ?? null}
        why={state.pending ? "Waiting for scans to send" : null}
        on={{ select: noop, change: noop }}
      />
      <Pin state={state} />
    </StationShell>
  );
}

/** Every Blast / Locate state by id, for /dev/station-gallery/<id>. */
export function FreezerScreen({ id }: { id: string }) {
  const blast = BLAST_STATES.find((s) => s.id === id);
  if (blast) return <BlastScreen state={blast} />;
  const locate = LOCATE_STATES.find((s) => s.id === id);
  return locate ? <LocateScreen state={locate} /> : null;
}
