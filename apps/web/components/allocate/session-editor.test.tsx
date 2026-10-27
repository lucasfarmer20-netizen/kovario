// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { FilletryClient } from "db";
import type { StationSession } from "@/components/intake/use-station-session";
import type { SessionSummary } from "./allocate-data";
import type { SessionDraft } from "./allocate-state";
import { SessionEditor } from "./session-editor";

afterEach(cleanup);

const TABLES: Record<string, unknown[]> = {
  box_size: [
    { id: "size-m", name: "Medium", max_lb: 50, fee: 12.5, is_active: true },
    { id: "size-l", name: "Large", max_lb: 90, fee: 15, is_active: true },
  ],
  species: [{ code: "salmon_silvers", name: "Silvers" }],
  processing_method: [{ code: "fillets", name: "Fillets" }],
  intake_line: [
    {
      intake_id: "i-1",
      species_code: "salmon_silvers",
      method_code: "fillets",
      lb: 60,
      est_yield_lb: 33,
    },
  ],
  allocation_intake: [],
};

const STORED = {
  id: "s-1",
  number: "ALC-0001",
  state: "draft",
  split_method: "weight",
  notes: null,
  party_customer_id: "c-1",
  party: { name: "Pat" },
  allocation_intake: [
    { intake: { id: "i-1", number: "INT-0001", state: "stored", customer: { name: "Pat" } } },
  ],
  settlement: [
    {
      id: "st-1",
      number: "STL-0001",
      angler_name: "Ann",
      customer_id: null,
      retail_note: null,
      state: "draft",
      settlement_species: [{ species_code: "salmon_silvers", method_code: "fillets", lb: 30 }],
      box_plan: [
        {
          id: "b-1",
          number: "BOX-0001",
          method: "ship",
          box_size_id: "size-l",
          weight_lb: 75,
          heavy_allowed: true,
          fulfillment_state: "planned",
        },
      ],
    },
  ],
};

/** How many upcoming loads of the stored session fail (a lost response). */
let failDraftLoads = 0;

/** RPC values resolve as data; a function value is called per call and returns {data, error}. */
function fakeClient(rpcs: Record<string, unknown>) {
  const rpc = vi.fn(async (name: string) => {
    const v = rpcs[name];
    return typeof v === "function" ? v() : { data: v ?? null, error: null };
  });
  const from = (table: string) => {
    const result = { data: TABLES[table] ?? [], error: null };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      in: () => q,
      not: () => q,
      order: () => q,
      limit: () => q,
      single: async () => {
        if (table === "allocation_session" && failDraftLoads > 0) {
          failDraftLoads -= 1;
          return { data: null, error: { message: "network down" } };
        }
        return { data: table === "allocation_session" ? STORED : null, error: null };
      },
      maybeSingle: async () => ({ data: null, error: null }),
      then: (ok: (v: typeof result) => unknown, fail: (e: unknown) => unknown) =>
        Promise.resolve(result).then(ok, fail),
    };
    return q;
  };
  return { client: { from, rpc } as unknown as FilletryClient, rpc };
}

const station = (client: FilletryClient): StationSession => ({
  client,
  claims: { userId: "u-1", orgId: "org-1", appRole: "staff", deviceId: null },
  siteName: "Counter",
});

const summary = (state: SessionSummary["state"]): SessionSummary => ({
  session_id: "s-1",
  number: "ALC-0001",
  state,
  split_method: "weight",
  pool: {
    total: 100,
    intakes: [
      {
        intake_id: "i-1",
        number: "INT-0001",
        amount: 100,
        billed_here: true,
        billed_by: "ALC-0001",
      },
    ],
  },
  settlements:
    state === "priced"
      ? [
          {
            settlement_id: "st-1",
            number: "STL-0001",
            angler_name: "Ann",
            state: "draft",
            weight_total_lb: 30,
            processing_share: 100,
            box_fee_total: 15,
            freight_total: 0,
            amount_total: 115,
          },
        ]
      : [],
});

const draft = (): SessionDraft => ({
  sessionId: "s-1",
  partyCustomerId: "c-1",
  partyName: "Pat",
  splitMethod: "weight",
  notes: "",
  intakes: [{ id: "i-1", number: "INT-0001", state: "stored", customer: "Pat" }],
  anglers: [
    {
      key: "st-1",
      id: "st-1",
      number: "STL-0001",
      angler_name: "Ann",
      customer_id: null,
      retail_note: "",
      paid: false,
      species: [{ key: "sp-1", species_code: "salmon_silvers", method_code: "fillets", lb: "30" }],
      boxes: [
        {
          key: "b-1",
          id: "b-1",
          number: "BOX-0001",
          method: "ship",
          box_size_id: "size-l",
          weight: "60",
          heavy_allowed: false,
          fulfillment_state: "planned",
        },
      ],
    },
  ],
});

it("heavy check gates the save; Save & Price sends the box plan (no vessel) then prices; receipts per angler", async () => {
  const { client, rpc } = fakeClient({
    save_allocation_session: summary("draft"),
    price_session: summary("priced"),
  });
  render(<SessionEditor session={station(client)} initial={draft()} summary={summary("draft")} />);
  await screen.findByRole("option", { name: "Large (≤90 lb, $15.00)" });

  // Live preview from packages/rules: the whole pool to the only angler, plus the box fee.
  const preview = screen.getByRole("table", { name: "Price preview" });
  expect(within(preview).getByText("$115.00")).toBeTruthy();

  fireEvent.change(screen.getByLabelText("Box weight lb"), { target: { value: "75" } });
  fireEvent.click(screen.getByText("Save & Price"));
  expect((await screen.findByRole("alert")).textContent).toMatch(/over 70 lb — tick Heavy OK/);
  expect(rpc).not.toHaveBeenCalled();

  fireEvent.click(screen.getByLabelText("Heavy OK (over 70 lb)"));
  fireEvent.click(screen.getByText("Save & Price"));
  await screen.findByText("ALC-0001 priced.");

  const save = rpc.mock.calls.find(([name]) => name === "save_allocation_session") as unknown as [
    string,
    { p_client_action_id: string; p_payload: Record<string, unknown> },
  ];
  expect(save[1].p_payload).toMatchObject({
    session_id: "s-1",
    split_method: "weight",
    intake_ids: ["i-1"],
    settlements: [
      {
        id: "st-1",
        boxes: [
          { id: "b-1", method: "ship", box_size_id: "size-l", weight_lb: 75, heavy_allowed: true },
        ],
      },
    ],
  });
  expect(JSON.stringify(save[1].p_payload)).not.toMatch(/vessel/);
  expect(rpc).toHaveBeenCalledWith("price_session", {
    p_client_action_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    p_session_id: "s-1",
  });

  const settlements = await screen.findByRole("table", { name: "Settlements" });
  expect(within(settlements).getByText("STL-0001")).toBeTruthy();
  expect(within(settlements).getByRole("link", { name: "Receipt" }).getAttribute("href")).toBe(
    "/allocate/receipt/st-1",
  );
});

it("a released box is read-only and a paid settlement locks the session", async () => {
  const { client } = fakeClient({});
  const d = draft();
  d.anglers[0]!.boxes[0]!.fulfillment_state = "picked_up";
  render(<SessionEditor session={station(client)} initial={d} summary={summary("priced")} />);
  await screen.findByText("picked_up");
  expect((screen.getByLabelText("Box weight lb") as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText("Save & Reprice")).toBeTruthy();
  cleanup();

  const paid = draft();
  paid.anglers[0]!.paid = true;
  render(<SessionEditor session={station(client)} initial={paid} summary={summary("priced")} />);
  await screen.findByText("Has a paid settlement");
  expect(screen.queryByText("Save & Reprice")).toBeNull();
});

/** A new session's draft (nothing stored yet): one angler, one heavy-confirmed box. */
const unsaved = (): SessionDraft => {
  const d = draft();
  return {
    ...d,
    sessionId: null,
    anglers: d.anglers.map((a) => ({
      ...a,
      id: null,
      number: null,
      boxes: a.boxes.map((b) => ({
        ...b,
        id: null,
        number: null,
        weight: "75",
        heavy_allowed: true,
      })),
    })),
  };
};

type SaveCall = [string, { p_client_action_id: string; p_payload: Record<string, unknown> }];
const saves = (rpc: ReturnType<typeof fakeClient>["rpc"]) =>
  rpc.mock.calls.filter(([name]) => name === "save_allocation_session") as unknown as SaveCall[];

it("pricing fails after the save commits: the editor keeps the saved session and the retry edits it", async () => {
  let priceCalls = 0;
  const { client, rpc } = fakeClient({
    save_allocation_session: summary("draft"),
    price_session: () =>
      ++priceCalls === 1
        ? { data: null, error: { message: "weight split needs take-home lb" } }
        : { data: summary("priced"), error: null },
  });
  const onSaved = vi.fn();
  render(
    <SessionEditor
      session={station(client)}
      initial={unsaved()}
      summary={null}
      onSaved={onSaved}
    />,
  );
  await screen.findByRole("option", { name: "Large (≤90 lb, $15.00)" });

  fireEvent.click(screen.getByText("Save & Price"));
  expect((await screen.findByText(/ALC-0001 saved, but not priced/)).textContent).toMatch(
    /take-home lb/,
  );
  expect(onSaved).not.toHaveBeenCalled();

  // Still a draft (pricing never ran or failed), so the button still reads Save & Price.
  fireEvent.click(screen.getByText("Save & Price"));
  await screen.findByText("ALC-0001 priced.");
  const [first, second] = saves(rpc);
  expect(first![1].p_payload).toMatchObject({ session_id: null, settlements: [{ id: null }] });
  // The retry edits the stored session and its rows — it never creates a second session.
  expect(second![1].p_payload).toMatchObject({
    session_id: "s-1",
    settlements: [{ id: "st-1", boxes: [{ id: "b-1" }] }],
  });
  expect(second![1].p_client_action_id).not.toBe(first![1].p_client_action_id);
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(onSaved.mock.calls[0]![0]).toMatchObject({ state: "priced" });
});

it("reloading the saved rows fails: edits are held and the retry replays the same save", async () => {
  failDraftLoads = 1;
  const { client, rpc } = fakeClient({
    save_allocation_session: summary("draft"),
    price_session: summary("priced"),
  });
  const onSaved = vi.fn();
  render(
    <SessionEditor
      session={station(client)}
      initial={unsaved()}
      summary={null}
      onSaved={onSaved}
    />,
  );
  await screen.findByRole("option", { name: "Large (≤90 lb, $15.00)" });

  fireEvent.click(screen.getByText("Save & Price"));
  await screen.findByText(/ALC-0001 was saved, but reloading it failed/);
  expect(rpc.mock.calls.some(([name]) => name === "price_session")).toBe(false);
  // Edits are held until the saved rows are adopted (they would otherwise be written twice).
  fireEvent.change(screen.getByLabelText("Angler 1 name"), { target: { value: "Changed" } });
  expect((screen.getByLabelText("Angler 1 name") as HTMLInputElement).value).toBe("Ann");

  // Still a draft (pricing never ran or failed), so the button still reads Save & Price.
  fireEvent.click(screen.getByText("Save & Price"));
  await screen.findByText("ALC-0001 priced.");
  const [first, second] = saves(rpc);
  expect(second![1].p_client_action_id).toBe(first![1].p_client_action_id); // replay, no new write
  expect(second![1].p_payload).toEqual(first![1].p_payload);
  expect(onSaved).toHaveBeenCalledTimes(1);
});
