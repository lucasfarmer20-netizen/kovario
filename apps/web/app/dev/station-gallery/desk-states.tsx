"use client";
import type { ReactNode } from "react";
import { buildIntakeDraft, referenceSeed, type IntakeLine } from "rules";
import { CustomerSearch } from "@/components/customers/customer-search";
import type { CustomerHit } from "@/components/customers/customer-search-state";
import type { PriceContext } from "@/components/intake/intake-data";
import { pricingFrom } from "@/components/intake/intake-data";
import { emptyRow, rowsToLines, type LineRow } from "@/components/intake/intake-form-state";
import {
  IntakeFormSkeleton,
  IntakeFormView,
  IntakeListView,
  IntakeSavedView,
  IntakeShell,
  SignInNeeded,
  intakeNextStep,
  savedNextStep,
  type Draft,
  type IntakeFormValues,
  type IntakeListRow,
  type Prompt,
  type SavedIntake,
} from "@/components/intake/intake-view";
import {
  PICKUP_STEPS,
  STORAGE_STEPS,
  StorageDetailSkeleton,
  StorageDetailView,
  StorageFormView,
  StorageQueueView,
  StorageShell,
  pickupNextStep,
  storageNextStep,
  type StorageBatch,
  type StorageBox,
  type StorageFormValues,
  type StorageOrder,
  type StorageQueueRow,
  type StorageRelease,
} from "@/components/storage/storage-view";
import type { Quote } from "@/components/storage/storage-data";
import { confirmPayload, type BoxRow } from "@/components/storage/storage-state";
import { KeyboardStatus, type KeyboardFeedback } from "@/src/components/station/keyboard-status";
import { ManualEntry } from "@/src/components/station/manual-entry";
import { ManagerPinOverlay } from "@/src/components/station/pin-overlay";
import type { NoticeTone } from "@/src/components/station/notice";

/** Static data for the gallery: no DB, no session; every handler is a no-op. */
const noop = () => undefined;
const preview = async () => ({ ok: false, reason: "Preview only" });
const noHits = async () => [];
const SITE = "Seward";
const OPERATOR = "Staff";

type DeskState = {
  id: string;
  title: string;
  note: string;
  operator?: string | null;
  online?: boolean;
  feedback?: { ok: boolean; text: string };
  notice?: { tone: NoticeTone; text: string };
};
const fb = (f: DeskState["feedback"]): KeyboardFeedback | null => (f ? { ...f, event: 1 } : null);
const status = (s: DeskState) => <KeyboardStatus feedback={fb(s.feedback)} notice={s.notice} />;
const OFFLINE_FORM = "Offline. Saving needs a connection; the order stays as typed.";

// ---- Intake ------------------------------------------------------------------------------

const REFERENCE = referenceSeed();
const CTX: PriceContext = {
  rate_card: { id: "card-1", name: "2026 rates" },
  rates: { fillets: 1.5, portions: 1.25, smoking: 2.75, ribbing_per_lb: 0.5, fast_pass_per_lb: 2 },
  lodge_cappable: { fillets: true, portions: true, smoking: true },
  customer: { id: "c1", is_lodge_guest: false, lodge_name: null, lodge_cap: null },
};
const CUSTOMER: CustomerHit = {
  id: "c1",
  name: "Pat Halvorsen",
  phone: "+19075550142",
  last_visit_at: null,
  is_lodge_guest: true,
  lodge_id: "l1",
  lodge_name: "Kenai River Lodge",
};
const row = (key: string, patch: Partial<LineRow>): LineRow => ({ ...emptyRow(), key, ...patch });
const SILVERS = row("l1", {
  species: "salmon_silvers",
  condition: "whole",
  method: "fresh",
  lb: "50",
  filletsPct: "60",
});
const HALIBUT = row("l2", {
  species: "whitefish_halibut",
  condition: "filleted_ribs",
  method: "portions",
  lb: "30",
});
const values = (patch: Partial<IntakeFormValues>): IntakeFormValues => ({
  customer: CUSTOMER,
  rows: [SILVERS, HALIBUT],
  toteCount: "2",
  dirtyFish: false,
  dirtyNotes: "",
  cutNotes: "",
  processingNotes: "",
  fastPass: false,
  printReceipt: false,
  ...patch,
});

type IntakeFormState = DeskState & {
  kind: "form";
  loading?: boolean;
  values: IntakeFormValues;
  ctx?: PriceContext;
  editing?: string;
  saving?: boolean;
};
type IntakeSavedState = DeskState & { kind: "saved"; intake: SavedIntake; pin?: boolean };
type IntakeListState = DeskState & { kind: "list"; rows: IntakeListRow[] | null };
type IntakeOtherState = DeskState & { kind: "signin" };
type IntakeState = IntakeFormState | IntakeSavedState | IntakeListState | IntakeOtherState;

const SAVED: SavedIntake = {
  number: "INT-2147",
  customer: CUSTOMER.name,
  phone: CUSTOMER.phone,
  chips: ["In cooler", "0h in cooler", "Locked", "Lodge"],
  flags: ["DIRTY", "RIBBING"],
  lines: [
    { id: "a", name: "Silvers", detail: "Whole · Fresh 60/40", lb: 50, estYield: 28 },
    { id: "b", name: "Halibut", detail: "Filleted (ribs in) · Portions", lb: 30, estYield: 21 },
  ],
  totalLb: 80,
  totalEstYield: 49,
  toteCount: 2,
  notes: [{ label: "Dirty fish", text: "Two silvers gut-shot, rinse well" }],
  charges: [
    {
      id: "1",
      description: "Fillets — Silvers",
      qty: 50,
      unitPrice: 1.5,
      amount: 75,
      state: "open",
    },
    {
      id: "2",
      description: "Portions — Halibut",
      qty: 30,
      unitPrice: 1.25,
      amount: 37.5,
      state: "open",
    },
    {
      id: "3",
      description: "Ribbing — Halibut",
      qty: 30,
      unitPrice: 0.5,
      amount: 15,
      state: "open",
    },
  ],
  timeline: [{ label: "Checked in", at: "2026-10-30T16:05:00Z" }],
  totes: [
    { no: 1, of: 2, qr: "FL:TOTE:INT-2147:1", queued: true },
    { no: 2, of: 2, qr: "FL:TOTE:INT-2147:2", queued: true },
  ],
  canUnlock: true,
  receiptHref: "/dev/station-gallery",
};
const LIST: IntakeListRow[] = [
  {
    id: "1",
    number: "INT-2147",
    detail: "Pat Halvorsen · In cooler · 80 lb · 2 totes",
    age: "0h in cooler",
    flags: ["DIRTY", "RIBBING"],
  },
  {
    id: "2",
    number: "INT-2146",
    detail: "Dana Ruiz · In cooler · 24 lb · 1 tote",
    age: "3h in cooler",
    flags: ["FAST PASS"],
  },
  { id: "3", number: "INT-2141", detail: "Lee Park · Reconcile · 40 lb · 3 totes", flags: [] },
];

export const INTAKE_STATES: IntakeState[] = [
  {
    id: "intake-loading",
    title: "Loading",
    note: "Placeholders in the shape of the form and the price rail; nothing jumps when they land.",
    kind: "form",
    loading: true,
    values: values({ customer: null }),
  },
  {
    id: "intake-signin",
    title: "Operator needed",
    note: "No staff sign-in and no paired tablet: Identify operator in the console bar, and the two ways in. The desk has no operator PIN; the sign-in is the operator.",
    kind: "signin",
    operator: null,
  },
  {
    id: "intake-new",
    title: "New order: find the customer",
    note: "Keyboard station: no scanner input, so typing goes to the phone search. Step 1 leads; Save waits and says why.",
    kind: "form",
    values: values({ customer: null, rows: [row("l0", {})], toteCount: "1" }),
  },
  {
    id: "intake-customer",
    title: "Customer picked, no lines yet",
    note: "Step 1 ticks off; the keyboard moves to line 1's species. Condition and method say what they wait for; the price says it shows once a line is complete.",
    kind: "form",
    values: values({ rows: [row("l0", {})], toteCount: "1" }),
  },
  {
    id: "intake-filling",
    title: "In progress: a line still needs its weight",
    note: "Line 1 is complete (green edge, check); line 2 had its method picked for it, so focus moved to its lb. The next step line names the field.",
    kind: "form",
    values: values({ rows: [SILVERS, { ...HALIBUT, lb: "" }] }),
  },
  {
    id: "intake-ready",
    title: "Ready to save",
    note: "Every line complete: the live price, then Save & Print Tote Tags as the one filled button. Totes have − / + beside the typed count.",
    kind: "form",
    values: values({ dirtyFish: true, dirtyNotes: "Two silvers gut-shot, rinse well" }),
  },
  {
    id: "intake-no-rate",
    title: "Warning: no rate on the card",
    note: "The rate card has no rate for a line's method: the next step line warns, Save is held and says why.",
    kind: "form",
    values: values({}),
    ctx: { ...CTX, rates: { fillets: 1.5, ribbing_per_lb: 0.5, fast_pass_per_lb: 2 } },
  },
  {
    id: "intake-rejected",
    title: "Save refused",
    note: "The server refused the save: red in the status tile, why and then what to do. Any edit clears it.",
    kind: "form",
    values: values({}),
    feedback: {
      ok: false,
      text: "The customer has an open order in the cooler with the same totes. Check the order and tap Save again.",
    },
  },
  {
    id: "intake-offline",
    title: "Offline",
    note: "Saving goes straight to the server: offline, Save waits and says so. The connection chip reads Offline; the form stays as typed.",
    kind: "form",
    values: values({}),
    online: false,
    notice: { tone: "info", text: OFFLINE_FORM },
  },
  {
    id: "intake-saved",
    title: "Saved and printed",
    note: "Green in the status tile; every step ticked. The number at readout size, as on its tags. Starting the next order is the filled button; Reprint, Print Receipt and Unlock sit beside it.",
    kind: "saved",
    intake: SAVED,
    feedback: { ok: true, text: "INT-2147 saved; 2 tote tags queued." },
  },
  {
    id: "intake-no-printer",
    title: "No tote printer",
    note: "The printer is the desk's device. With none set up, the tags show Not printed, and the next step line says to write the number on each tote (the manual path).",
    kind: "saved",
    intake: { ...SAVED, totes: SAVED.totes.map((t) => ({ ...t, queued: false })) },
    feedback: { ok: true, text: "INT-2147 saved. No tote printer is set up for this site." },
  },
  {
    id: "intake-unlock",
    title: "Needs a manager: Unlock",
    note: "A locked order changes only after a manager unlocks it: the manager PIN sheet rises (non-modal).",
    kind: "saved",
    intake: SAVED,
    pin: true,
  },
  {
    id: "intake-unlocked",
    title: "Unlocked: editing",
    note: "The unlocked panel takes the top of the work area; saving locks the order again.",
    kind: "form",
    editing: "INT-2147",
    values: values({}),
  },
  {
    id: "intake-orders",
    title: "Orders",
    note: "Newest first, as order tiles: customer, state, lb and totes, hours in the cooler, flags. A tap opens the order.",
    kind: "list",
    rows: LIST,
  },
  {
    id: "intake-orders-empty",
    title: "No orders yet",
    note: "Says where orders come from.",
    kind: "list",
    rows: [],
  },
];

function draftFor(rows: LineRow[], ctx: PriceContext, fastPass: boolean): Draft {
  const lines: IntakeLine[] = rowsToLines(rows).lines;
  if (lines.length === 0) return null;
  try {
    return buildIntakeDraft(lines, pricingFrom(ctx, fastPass));
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Line not allowed" };
  }
}

/** A whole Intake screen in one gallery state, as the live station renders it. */
export function IntakeScreen({ state }: { state: IntakeState }) {
  const shell = (prompt: Prompt, body: ReactNode, steps = true) => (
    <IntakeShell
      site={SITE}
      operator={state.operator === undefined ? OPERATOR : state.operator}
      prompt={prompt}
      steps={steps}
      status={status(state)}
      online={state.online}
    >
      {body}
    </IntakeShell>
  );
  if (state.kind === "signin")
    return shell(
      { next: "Sign in or pair this tablet", step: 0 },
      <SignInNeeded what="take orders" />,
    );
  if (state.kind === "list")
    return shell(
      { next: "Tap an order to open it" },
      <IntakeListView rows={state.rows} filter="" error="" on={{ filter: noop, open: noop }} />,
      false,
    );
  if (state.kind === "saved")
    return shell(
      savedNextStep(state.intake),
      <>
        <IntakeSavedView
          intake={state.intake}
          busy={Boolean(state.pin)}
          on={{ newIntake: noop, reprint: noop, printReceipt: noop, unlock: noop }}
        />
        {state.pin && <ManagerPinOverlay onClose={noop} verify={preview} />}
      </>,
    );
  const ctx = state.ctx ?? CTX;
  const draft = draftFor(state.values.rows, ctx, state.values.fastPass);
  const prompt = intakeNextStep({
    customer: state.values.customer !== null,
    rows: state.values.rows,
    toteCount: state.values.toteCount,
    priced: true,
    draft,
    online: state.online !== false,
  });
  if (state.loading)
    return shell({ next: "Opening the order form", step: 0 }, <IntakeFormSkeleton />);
  return shell(
    prompt,
    <IntakeFormView
      reference={REFERENCE}
      ctx={ctx}
      draft={draft}
      values={state.values}
      editing={state.editing}
      saveWhy={prompt.saveWhy}
      saving={Boolean(state.saving)}
      customerSearch={
        <CustomerSearch label="Customer phone or name" search={noHits} onSelect={noop} />
      }
      on={{
        changeCustomer: noop,
        setRow: noop,
        addRow: noop,
        removeRow: noop,
        set: noop,
        save: noop,
      }}
    />,
  );
}

// ---- Storage intake ----------------------------------------------------------------------

const LOCATIONS = [
  { id: "loc-1", code: "IF-PALLET-01" },
  { id: "loc-2", code: "IF-A-01-1-F" },
];
const box = (key: string, weight: string, description: string): BoxRow => ({
  key,
  weight,
  description,
});
const storageValues = (patch: Partial<StorageFormValues>): StorageFormValues => ({
  customer: CUSTOMER,
  locationId: "loc-1",
  rows: [box("b1", "20", "Halibut fillets"), box("b2", "15", "Lingcod")],
  notes: "",
  ...patch,
});
const ORDER: StorageOrder = {
  number: "STG-0009",
  customer: CUSTOMER.name,
  phone: "(907) 555-0142",
  chips: ["Stored", "3 boxes stored", "IF-PALLET-01"],
  notes: "Customer picks up the kings after the holiday.",
};
const sbox = (n: number, weight: number, description: string, days: number): StorageBox => ({
  id: `b-${n}`,
  label: `Box ${n}`,
  stored: true,
  weight,
  description,
  days,
  qr: `FL:SBOX:STG-0009:${n}`,
});
const BOXES = [
  sbox(1, 20, "Halibut fillets", 3),
  sbox(2, 15, "Lingcod", 3),
  sbox(3, 22, "Kings", 3),
];
const QUOTE: Quote = {
  rate: 0.75,
  box_days: 6,
  amount: 4.5,
  boxes: [
    { box_id: "b-1", box_no: 1, label: "Box 1", days: 3, amount: 2.25 },
    { box_id: "b-3", box_no: 3, label: "Box 3", days: 3, amount: 2.25 },
  ],
};
const PENDING: StorageBatch = {
  id: "spb-4",
  number: "SPB-0004",
  code: "pending",
  state: "Awaiting payment",
  releaseFailed: false,
  boxes: "Box 1, Box 3",
  amount: 4.5,
  paymentRef: null,
  notes: null,
};

type StorageFormState = DeskState & { kind: "form"; loading?: boolean; values: StorageFormValues };
type StorageDetailState = DeskState & {
  kind: "detail";
  loading?: boolean;
  boxes?: StorageBox[];
  selected?: string[];
  quote?: Quote | null;
  batches?: StorageBatch[];
  release?: StorageRelease | null;
  typing?: boolean;
  pin?: boolean;
};
type StorageQueueState = DeskState & { kind: "queue"; rows: StorageQueueRow[] | null };
type StorageOtherState = DeskState & { kind: "signin" };
type StorageState = StorageFormState | StorageDetailState | StorageQueueState | StorageOtherState;

export const STORAGE_STATES: StorageState[] = [
  {
    id: "storage-loading",
    title: "Loading",
    note: "Placeholders in the shape of the form and the labels rail.",
    kind: "form",
    loading: true,
    values: storageValues({ customer: null }),
  },
  {
    id: "storage-signin",
    title: "Operator needed",
    note: "No staff sign-in and no paired tablet: Identify operator, and the two ways in.",
    kind: "signin",
    operator: null,
  },
  {
    id: "storage-new",
    title: "New storage: find the customer",
    note: "Keyboard station: typing goes to the phone search. Confirm waits and says why.",
    kind: "form",
    values: storageValues({ customer: null, locationId: "", rows: [box("b1", "", "")] }),
  },
  {
    id: "storage-customer",
    title: "Customer picked, no boxes entered",
    note: "Step 1 ticks off; the keyboard moves to Location, then the boxes. Location, weight and description stay optional (as the server takes them), so Confirm is live; the next step line says what usually comes next.",
    kind: "form",
    values: storageValues({ locationId: "", rows: [box("b1", "", "")] }),
  },
  {
    id: "storage-boxes",
    title: "In progress: boxes entered",
    note: "Each entered box ticks green; the rail lists the labels Confirm prints. Add box moves the keyboard to the new box's weight.",
    kind: "form",
    values: storageValues({}),
  },
  {
    id: "storage-bad-weight",
    title: "Warning: a weight that is not a number",
    note: "The next step line warns with the box and the fix; Confirm is held and says why.",
    kind: "form",
    values: storageValues({
      rows: [box("b1", "20", "Halibut fillets"), box("b2", "15 lb?", "Lingcod")],
    }),
  },
  {
    id: "storage-rejected",
    title: "Confirm refused",
    note: "The server refused: red in the status tile, why and then what to do.",
    kind: "form",
    values: storageValues({}),
    feedback: {
      ok: false,
      text: "Location IF-PALLET-01 is archived. Check the boxes and tap Confirm again.",
    },
  },
  {
    id: "storage-offline",
    title: "Offline",
    note: "Confirm goes straight to the server: offline, it waits and says so.",
    kind: "form",
    values: storageValues({}),
    online: false,
    notice: { tone: "info", text: "Offline. Confirm needs a connection; the boxes stay as typed." },
  },
  {
    id: "storage-stored",
    title: "Stored and labelled",
    note: "Green in the status tile. The number at readout size, as on its box labels; the boxes are ready to tick for a pickup.",
    kind: "detail",
    feedback: { ok: true, text: "STG-0009 stored; 3 box labels queued." },
  },
  {
    id: "storage-no-printer",
    title: "No label printer",
    note: "The labels did not print: the status tile says so in words, and Reprint Labels retries once a printer is set up.",
    kind: "detail",
    feedback: { ok: true, text: "STG-0009 stored. No label printer is set up for this site." },
  },
  {
    id: "storage-pickup",
    title: "Pickup: boxes ticked",
    note: "Each box is a whole-row tick (72 px). The server prices the ticked boxes in the rail; Create Pickup Batch is the filled button.",
    kind: "detail",
    selected: ["b-1", "b-3"],
    quote: QUOTE,
  },
  {
    id: "storage-typed-box",
    title: "Box code typed: rejected",
    note: "Enter manually reads a box label's code (checked and logged by the server). A code from another order is refused in the status tile.",
    kind: "detail",
    typing: true,
    feedback: { ok: false, text: "STG-0008-1 is not on STG-0009." },
  },
  {
    id: "storage-charge",
    title: "Batch waiting at the register",
    note: "Step 2 ticks off: the batch is charged at the register, then its boxes release.",
    kind: "detail",
    batches: [PENDING],
    feedback: { ok: true, text: "SPB-0004 for $4.50 is ready to charge at the register." },
  },
  {
    id: "storage-release",
    title: "Needs a manager: Force Release",
    note: "The release panel takes the top of the work area: a reason, then the manager PIN.",
    kind: "detail",
    batches: [PENDING],
    release: { number: "SPB-0004", amount: 4.5, mode: "manual", reason: "Paid by phone" },
  },
  {
    id: "storage-release-pin",
    title: "Manager PIN",
    note: "The manager PIN sheet rises over the panel (non-modal).",
    kind: "detail",
    batches: [PENDING],
    release: { number: "SPB-0004", amount: 4.5, mode: "comp", reason: "Freezer outage" },
    pin: true,
  },
  {
    id: "storage-queue",
    title: "Storage queue",
    note: "Oldest first, as order tiles: customer, state, boxes left, location, days stored, pickups awaiting payment.",
    kind: "queue",
    rows: [
      {
        id: "1",
        number: "STG-0004",
        detail: "Lee Park · Partly picked up · 2 of 5 boxes left · IF-A-01-1-F",
        age: "41 days",
        flags: ["1 pickup awaiting payment"],
      },
      {
        id: "2",
        number: "STG-0009",
        detail: "Pat Halvorsen · Stored · 3 boxes stored · IF-PALLET-01",
        age: "3 days",
        flags: [],
      },
    ],
  },
  {
    id: "storage-queue-empty",
    title: "Nothing in storage",
    note: "Says where storage orders come from.",
    kind: "queue",
    rows: [],
  },
];

/** A whole Storage screen in one gallery state, as the live station renders it. */
export function StorageScreen({ state }: { state: StorageState }) {
  const shell = (prompt: Prompt, steps: readonly string[] | undefined, body: ReactNode) => (
    <StorageShell
      site={SITE}
      operator={state.operator === undefined ? OPERATOR : state.operator}
      prompt={prompt}
      steps={steps}
      status={status(state)}
      online={state.online}
    >
      {body}
    </StorageShell>
  );
  if (state.kind === "signin")
    return shell(
      { next: "Sign in or pair this tablet", step: 0 },
      STORAGE_STEPS,
      <SignInNeeded what="take storage" />,
    );
  if (state.kind === "queue")
    return shell(
      { next: "Tap a storage order to open it" },
      undefined,
      <StorageQueueView rows={state.rows} filter="" error="" on={{ filter: noop, open: noop }} />,
    );
  if (state.kind === "detail") {
    const selected = state.selected ?? [];
    const batches = state.batches ?? [];
    const prompt: Prompt = state.release
      ? { next: "Enter the reason, then a manager PIN", step: 2, tone: "warn" }
      : pickupNextStep(
          selected.length,
          batches.some((b) => b.code === "pending"),
        );
    return shell(
      prompt,
      PICKUP_STEPS,
      state.loading ? (
        <StorageDetailSkeleton />
      ) : (
        <>
          <StorageDetailView
            order={ORDER}
            boxes={state.boxes ?? BOXES}
            selected={selected}
            quote={state.quote ?? null}
            batches={batches}
            release={state.release ?? null}
            receipt={null}
            busy={Boolean(state.pin)}
            manual={
              <ManualEntry
                open={Boolean(state.typing)}
                onOpenChange={noop}
                onSubmit={noop}
                label="Box (STG-0001-2)"
                placeholder="STG-0009-2"
              />
            }
            on={{
              toggle: noop,
              createBatch: noop,
              reprintLabels: noop,
              printReceipt: noop,
              receipt: noop,
              closeReceipt: noop,
              cancelBatch: noop,
              startRelease: noop,
              releaseReason: noop,
              confirmRelease: noop,
              cancelRelease: noop,
            }}
          />
          {state.pin && <ManagerPinOverlay onClose={noop} verify={preview} />}
        </>
      ),
    );
  }
  const v = state.values;
  const built = confirmPayload({
    customerId: v.customer?.id ?? null,
    locationId: v.locationId,
    notes: v.notes,
    rows: v.rows,
  });
  const prompt = storageNextStep({
    customer: v.customer !== null,
    location: v.locationId !== "",
    rows: v.rows,
    problems:
      "errors" in built ? built.errors.filter((e) => e !== "Pick or create the customer.") : [],
    online: state.online !== false,
  });
  return shell(
    state.loading ? { next: "Opening storage", step: 0 } : prompt,
    STORAGE_STEPS,
    <StorageFormView
      loading={Boolean(state.loading)}
      locations={LOCATIONS}
      values={v}
      confirmWhy={prompt.confirmWhy}
      saving={false}
      customerSearch={
        <CustomerSearch label="Customer phone or name" search={noHits} onSelect={noop} />
      }
      on={{
        changeCustomer: noop,
        location: noop,
        setRow: noop,
        addRow: noop,
        removeRow: noop,
        notes: noop,
        confirm: noop,
      }}
    />,
  );
}

/** One desk (Intake or Storage) gallery state by id. */
export function DeskScreen({ id }: { id: string }) {
  const intake = INTAKE_STATES.find((s) => s.id === id);
  if (intake) return <IntakeScreen state={intake} />;
  const storage = STORAGE_STATES.find((s) => s.id === id);
  return storage ? <StorageScreen state={storage} /> : null;
}
