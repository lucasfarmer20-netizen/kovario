"use client";
import { WAVE_STEPS, waveNextStep, waveWhy } from "@/components/wave/wave-station";
import {
  WaveView,
  type OpenWave,
  type WaveQueueItem,
  type WaveTile,
} from "@/components/wave/wave-view";
import { StationShell } from "@/src/components/station/station-shell";
import { FeedbackBanner, type FeedbackTone } from "@/src/components/station/scan-feedback";
import { StationNotice, type NoticeTone } from "@/src/components/station/notice";
import { OperatorPinOverlay } from "@/src/components/station/pin-overlay";

/** Static data for the gallery: no DB, no session; every handler is a no-op. */
const noop = () => undefined;
const TARGET = { lb: 600, tolerance: 50 };

const order = (
  id: string,
  number: string,
  species: string,
  lb: number,
  totes: number,
  hours: number,
  flags: string[] = [],
): WaveQueueItem => ({
  id,
  number,
  detail: `${species} · ${lb} lb · ${totes} ${totes === 1 ? "tote" : "totes"}`,
  age: `${hours}h in cooler`,
  flags,
  lb,
  totes,
});
const QUEUE: WaveQueueItem[] = [
  order("i1", "INT-2150", "Reds, Silvers", 184, 3, 52, ["FAST PASS"]),
  order("i2", "INT-2151", "Halibut", 226, 2, 49),
  order("i3", "INT-2152", "Kings", 142, 2, 47, ["DIRTY", "RIBBING"]),
  order("i4", "INT-2153", "Lingcod, Rockfish", 96, 1, 31),
  order("i5", "INT-2154", "Silvers", 118, 2, 26),
];
const IN_WAVE = [
  { id: "m1", number: "INT-2146", detail: "Reds · 210 lb", totes: 3 },
  { id: "m2", number: "INT-2147", detail: "Halibut, Lingcod · 254 lb", totes: 2 },
  { id: "m3", number: "INT-2149", detail: "Kings · 128 lb", totes: 2 },
];
/** WAVE-0012 with the given totes scanned, per order. */
function wave(state: OpenWave["state"], scanned: number[][]): OpenWave {
  const members = IN_WAVE.map((m, n) => ({ ...m, scanned: scanned[n] ?? [] }));
  return {
    id: "w12",
    number: "WAVE-0012",
    state,
    scanned: members.reduce((sum, m) => sum + m.scanned.length, 0),
    expected: members.reduce((sum, m) => sum + m.totes, 0),
    members,
  };
}
const tile = (w: OpenWave): WaveTile => ({
  id: w.id,
  number: w.number,
  detail:
    w.state === "draft"
      ? `Not started · ${w.members.length} orders`
      : `Checking totes · ${w.scanned} of ${w.expected}`,
});
const REFUSAL =
  "An order in this wave is no longer in the cooler. Cancel the wave and start again.";

export type WaveGalleryState = {
  id: string;
  title: string;
  /** What the state demonstrates. */
  note: string;
  loading?: boolean;
  queue?: WaveQueueItem[];
  selected?: string[];
  wave?: OpenWave | null;
  refused?: boolean;
  manualOpen?: boolean;
  feedback?: { tone: FeedbackTone; text: string };
  notice?: { tone: NoticeTone; text: string };
  operator?: string | null;
  pending?: number;
  online?: boolean;
  pin?: boolean;
};

export const WAVE_GALLERY_STATES: WaveGalleryState[] = [
  {
    id: "wave-loading",
    title: "Loading",
    note: "Placeholders hold the layout while the first load is out; nothing jumps when it lands.",
    loading: true,
  },
  {
    id: "wave-pin",
    title: "Operator needed",
    note: "Identify operator (salmon) and the PIN sheet; the floor stays visible behind it. Wave has no manager gate.",
    operator: null,
    pin: true,
  },
  {
    id: "wave-empty-queue",
    title: "Cooler empty",
    note: "No orders waiting: the queue says where orders come from; Start Verification says why it waits.",
    queue: [],
  },
  {
    id: "wave-no-selection",
    title: "Nothing tapped",
    note: "The cooler queue oldest first, with age and FAST PASS / DIRTY / RIBBING. Tap orders, or Suggest FIFO fill.",
  },
  {
    id: "wave-selecting",
    title: "Orders tapped",
    note: "Tapped orders are framed with Added and a check; the weight shows against the target band (a suggestion, no verdict).",
    selected: ["i1", "i2", "i3"],
  },
  {
    id: "wave-started",
    title: "Wave started, no totes yet",
    note: "One tap created the wave and started verification. Every tote is expected; Complete says why it waits.",
    wave: wave("verifying", []),
    feedback: undefined,
    notice: { tone: "ok", text: "Wave started. Scan each tote." },
  },
  {
    id: "wave-scanning",
    title: "Scanning totes",
    note: "Accept in the scan tile; the count and each order's totes tick off as they land.",
    wave: wave("verifying", [[1, 2, 3], [1], []]),
    feedback: { tone: "ok", text: "Tote accepted" },
  },
  {
    id: "wave-manual-tote",
    title: "Scanner down: Enter manually",
    note: "Wave has no scale or printer; with the scanner down, the tote number is typed. The scanner pauses while the field is open.",
    wave: wave("verifying", [[1, 2, 3], [1], []]),
    manualOpen: true,
  },
  {
    id: "wave-rejected",
    title: "Rejected scan",
    note: "Says why, then what to do; red, a cross and a shake, in the same tile as accepts.",
    wave: wave("verifying", [[1, 2, 3], [1], []]),
    feedback: { tone: "rejected", text: "Tote not found. Scan a tote from this wave." },
  },
  {
    id: "wave-ready",
    title: "Every tote scanned",
    note: "Parity: the count turns green with a check and Complete is the one thing left.",
    wave: wave("verifying", [
      [1, 2, 3],
      [1, 2],
      [1, 2],
    ]),
    feedback: { tone: "ok", text: "Tote accepted" },
  },
  {
    id: "wave-refused",
    title: "Complete refused",
    note: "The reply leads the next step line in red; Complete is restyled and Cancel wave becomes the filled way forward.",
    wave: wave("verifying", [
      [1, 2, 3],
      [1, 2],
      [1, 2],
    ]),
    refused: true,
    notice: { tone: "error", text: REFUSAL },
  },
  {
    id: "wave-draft",
    title: "Wave not started",
    note: "A wave whose start did not go through stays in draft, with Start Verification on it.",
    wave: wave("draft", []),
  },
  {
    id: "wave-done",
    title: "Wave complete",
    note: "Green confirmation under the scan tile; the next wave is live straight away.",
    notice: { tone: "ok", text: "Wave WAVE-0012 complete. Its orders are in processing." },
  },
  {
    id: "wave-offline",
    title: "Offline · 3 pending",
    note: "Scans are kept on the tablet; Complete and Cancel need the server, and say so.",
    wave: wave("verifying", [
      [1, 2, 3],
      [1, 2],
      [1, 2],
    ]),
    pending: 3,
    online: false,
    notice: {
      tone: "info",
      text: "Offline. Scans are saved on this tablet and send when the connection is back.",
    },
  },
];

/** The Wave screen for a gallery state id, or null when the id is another station's. */
export function WaveGalleryScreen({ id }: { id: string }) {
  const state = WAVE_GALLERY_STATES.find((s) => s.id === id);
  return state ? <WaveScreen state={state} /> : null;
}

/** A whole Wave screen in one gallery state, as the live station renders it. */
export function WaveScreen({ state }: { state: WaveGalleryState }) {
  const open = state.wave ?? null;
  const queue = state.queue ?? QUEUE;
  const selected = state.selected ?? [];
  const pending = state.pending ?? 0;
  const prompt = waveNextStep(
    open ?? undefined,
    selected.length,
    open?.scanned ?? 0,
    open?.expected ?? 0,
  );
  const why = waveWhy({
    wave: open ?? undefined,
    chosen: selected.length,
    scanned: open?.scanned ?? 0,
    expected: open?.expected ?? 0,
    pending,
    online: state.online ?? true,
  });
  const paused = Boolean(state.pin) || Boolean(state.manualOpen);
  return (
    <StationShell
      name="Wave batch"
      site="Seward"
      operator={state.operator === undefined ? "Dana R." : state.operator}
      pending={pending}
      online={state.online}
      paused={Boolean(state.pin)}
      next={state.refused ? REFUSAL : prompt.next}
      nextTone={state.refused ? "warn" : undefined}
      steps={WAVE_STEPS}
      step={state.loading ? 0 : prompt.step}
      manualLabel="Tote number (INT-0002-1)"
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
      <WaveView
        loading={Boolean(state.loading)}
        queue={queue}
        selected={selected}
        target={TARGET}
        waves={open ? [tile(open)] : []}
        wave={open}
        why={why}
        refused={Boolean(state.refused)}
        disabled={false}
        on={{
          toggle: noop,
          suggest: noop,
          start: noop,
          openWave: noop,
          newWave: noop,
          advance: noop,
          cancel: noop,
        }}
      />
      {state.pin && (
        <OperatorPinOverlay
          onClose={noop}
          verify={async () => ({ ok: false, reason: "Preview only" })}
        />
      )}
    </StationShell>
  );
}
