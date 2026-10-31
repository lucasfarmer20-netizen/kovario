// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { FilletryClient } from "db";
import type { StationSession } from "@/components/intake/use-station-session";
import { StorageDetail } from "./storage-detail";
import { StorageForm } from "./storage-form";
import { renderStorageLabels } from "./storage-labels";

afterEach(cleanup);

const INTAKE = {
  id: "si-1",
  number: "STG-0007",
  state: "stored",
  intake_at: "2026-10-24T18:00:00Z",
  notes: null,
  box_count: 3,
  active_box_count: 3,
  paid_at: null,
  payment_ref: null,
  customer: { name: "Sam Store", phone: null },
  location: { code: "IF-PALLET-01" },
};
const box = (n: number, days: number) => ({
  storage_box_id: `b-${n}`,
  box_no: n,
  label: `Box ${n}`,
  state: "stored",
  released_at: null,
  days_stored: days,
  weight_lb: 20,
  description: null,
  batch_id: null,
});
const TABLES: Record<string, unknown[]> = {
  storage_box_days: [box(1, 3), box(2, 3), box(3, 3)],
  storage_pickup_batch: [],
  location: [{ id: "loc-1", code: "IF-PALLET-01" }],
};

/** A stand-in for supabase-js: table reads resolve TABLES, RPCs resolve `rpcs`. */
function fakeClient(rpcs: Record<string, unknown>) {
  // A PostgREST builder: thenable, with setHeader (a typed code's entry-method header).
  const headers: string[] = [];
  const rpc = vi.fn((name: string, args?: Record<string, unknown>): unknown => {
    const reply = rpcs[name];
    const data = typeof reply === "function" ? (reply as (a: unknown) => unknown)(args) : reply;
    const builder = Object.assign(Promise.resolve({ data: data ?? null, error: null }), {
      setHeader: (header: string, value: string) => {
        headers.push(`${name} ${header}: ${value}`);
        return builder;
      },
    });
    return builder;
  });
  const from = (table: string) => {
    const result = { data: TABLES[table] ?? [], error: null };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      in: () => q,
      order: () => q,
      limit: () => q,
      // storage_intake: the intake; action_log: not yet completed
      maybeSingle: async () => ({ data: table === "storage_intake" ? INTAKE : null, error: null }),
      then: (ok: (v: typeof result) => unknown, fail: (e: unknown) => unknown) =>
        Promise.resolve(result).then(ok, fail),
    };
    return q;
  };
  return { client: { from, rpc } as unknown as FilletryClient, rpc, headers };
}

const session = (client: FilletryClient): StationSession => ({
  client,
  claims: { userId: "u-1", orgId: "org-1", appRole: "staff", deviceId: null },
  siteName: "Dock",
});

it("pickup wizard: days from the box view, tick boxes → server quote → Create Pickup Batch", async () => {
  const quote = {
    rate: 0.75,
    box_days: 6,
    amount: 4.5,
    boxes: [
      { box_id: "b-1", box_no: 1, label: "Box 1", days: 3, amount: 2.25 },
      { box_id: "b-3", box_no: 3, label: "Box 3", days: 3, amount: 2.25 },
    ],
  };
  const { client, rpc } = fakeClient({
    storage_pickup_quote: quote,
    create_pickup_batch: { ...quote, batch_id: "spb-1", number: "SPB-0004", superseded: [] },
  });
  render(<StorageDetail session={session(client)} storageIntakeId="si-1" />);

  const boxes = await screen.findByLabelText("Boxes");
  // Days stored come from the storage_box_days view, QR text from packages/rules qr.ts.
  expect(within(boxes).getAllByText("3 days")).toHaveLength(3);
  expect(within(boxes).getByText("FL:SBOX:STG-0007:2")).toBeTruthy();

  fireEvent.click(screen.getByLabelText("Pick up Box 1"));
  fireEvent.click(screen.getByLabelText("Pick up Box 3"));
  await screen.findByText("6 box-days");
  expect(screen.getByText("Total $4.50")).toBeTruthy();
  expect(rpc).toHaveBeenLastCalledWith("storage_pickup_quote", {
    p_storage_intake_id: "si-1",
    p_box_ids: ["b-1", "b-3"],
  });

  fireEvent.click(screen.getByText("Create Pickup Batch"));
  await screen.findByText("SPB-0004 for $4.50 is ready to charge at the register.");
  const create = rpc.mock.calls.find(([name]) => name === "create_pickup_batch") as unknown as [
    string,
    { p_client_action_id: string; p_storage_intake_id: string; p_box_ids: string[] },
  ];
  expect(create[1]).toMatchObject({ p_storage_intake_id: "si-1", p_box_ids: ["b-1", "b-3"] });
  expect(create[1].p_client_action_id).toMatch(/^[0-9a-f-]{36}$/);
});

it("storage form: refuses without a customer; Confirm sends the boxes, then queues their rendered ZPL labels", async () => {
  const confirmed = {
    storage_intake_id: "si-9",
    number: "STG-0009",
    labels: {
      storage_intake_id: "si-9",
      storage_number: "STG-0009",
      customer: "Sam Store",
      date: "2026-10-27",
      boxes: [
        { box_id: "box-1", box_no: 1 },
        { box_id: "box-2", box_no: 2 },
      ],
    },
  };
  const queued = { label_jobs_queued: 2, printer_missing: false };
  const hit = {
    id: "cust-1",
    name: "Sam Store",
    phone: "+19075550101",
    last_visit_at: null,
    is_lodge_guest: false,
    lodge_id: null,
    lodge_name: null,
  };
  const { client, rpc } = fakeClient({
    confirm_storage_intake: confirmed,
    search_customers: [hit],
    queue_storage_labels: queued,
  });
  const onConfirmed = vi.fn();
  render(<StorageForm session={session(client)} onConfirmed={onConfirmed} />);
  await screen.findByRole("option", { name: "IF-PALLET-01" });

  fireEvent.change(screen.getByLabelText("Box 1 weight"), { target: { value: "20" } });
  fireEvent.click(screen.getByText("Add box"));
  fireEvent.change(screen.getByLabelText("Box 2 description"), { target: { value: " kings " } });
  // Confirm waits for the customer and says so (it used to refuse after the tap).
  const confirm = screen.getByRole("button", { name: "Confirm & Print 2 Labels" });
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Pick the customer first")).toBeTruthy();
  fireEvent.click(confirm);
  expect(rpc).not.toHaveBeenCalledWith("confirm_storage_intake", expect.anything());

  fireEvent.change(screen.getByLabelText("Customer phone or name"), { target: { value: "907" } });
  fireEvent.click(await screen.findByText("Sam Store"));
  fireEvent.change(screen.getByLabelText("Location"), { target: { value: "loc-1" } });
  fireEvent.click(screen.getByText("Confirm & Print 2 Labels"));
  await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith(confirmed, queued));
  expect(rpc).toHaveBeenCalledWith("confirm_storage_intake", {
    p_client_action_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    p_payload: {
      customer_id: "cust-1",
      location_id: "loc-1",
      notes: null,
      boxes: [
        { weight_lb: 20, description: null },
        { weight_lb: null, description: "kings" },
      ],
    },
  });
  // Labels are rendered with the WP-08 template (non-empty ZPL with the SBOX QR), not left empty.
  const queue = rpc.mock.calls.find(([name]) => name === "queue_storage_labels") as unknown as [
    string,
    { p_storage_intake_id: string; p_labels: { box_id: string; zpl: string }[] },
  ];
  expect(queue[1].p_storage_intake_id).toBe("si-9");
  expect(queue[1].p_labels).toEqual(renderStorageLabels(confirmed.labels));
  expect(
    queue[1].p_labels.map((l) => [l.box_id, l.zpl.includes("^FDLA,FL:SBOX:STG-0009:")]),
  ).toEqual([
    ["box-1", true],
    ["box-2", true],
  ]);
});

/** Stand-in for public.storage_box_scan (25_storage_box_scan.test.sql pins the real one). */
function storageBoxScan(args: unknown) {
  const { p_storage_number: number, p_box_no: no } = args as {
    p_storage_number?: string;
    p_box_no?: number;
  };
  if (number === undefined || no === undefined)
    return { ok: false, reason: "Not a box code. Enter it as printed, e.g. STG-0001-2." };
  if (number !== "STG-0007") return { ok: false, reason: `${number}-${no} is not on STG-0007.` };
  if (no > 3) return { ok: false, reason: `No box ${no} on STG-0007.` };
  return { ok: true, reason: `Box ${no} selected for pickup.`, box_id: `b-${no}` };
}

it("#84 freezer pickup Enter manually: every typed box code is checked and logged by the server", async () => {
  const { client, rpc, headers } = fakeClient({ storage_box_scan: storageBoxScan });
  render(<StorageDetail session={session(client)} storageIntakeId="si-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Enter manually" }));
  expect(screen.getByTestId("next-step").textContent).toBe("Tick each box going home");
  const field = screen.getByLabelText("Box (STG-0001-2)");
  const enter = (value: string) => {
    fireEvent.change(field, { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Enter" }));
  };
  enter("stg-0007 2");
  await waitFor(() =>
    expect((screen.getByLabelText("Pick up Box 2") as HTMLInputElement).checked).toBe(true),
  );
  expect(screen.getByText("Box 2 selected for pickup.")).toBeTruthy();
  expect(screen.getByTestId("next-step").textContent).toBe("Tap Create Pickup Batch");
  // Replies land in the status tile (docs/12: one place for feedback), red with why and what to do.
  enter("STG-0008-1");
  await screen.findByText("STG-0008-1 is not on STG-0007.");
  enter("STG-0007-9");
  await screen.findByText("No box 9 on STG-0007.");
  enter("hello");
  await screen.findByText(/^Not a box code/);
  expect((screen.getByLabelText("Pick up Box 1") as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText("Pick up Box 2") as HTMLInputElement).checked).toBe(true);
  // Accepted and rejected codes alike reach the server (validated, logged), flagged manual.
  const calls = rpc.mock.calls.filter(([name]) => name === "storage_box_scan").map(([, a]) => a);
  expect(calls).toEqual([
    expect.objectContaining({
      p_raw: "FL:SBOX:STG-0007:2",
      p_storage_intake_id: "si-1",
      p_storage_number: "STG-0007",
      p_box_no: 2,
    }),
    expect.objectContaining({ p_raw: "FL:SBOX:STG-0008:1", p_storage_number: "STG-0008" }),
    expect.objectContaining({ p_raw: "FL:SBOX:STG-0007:9", p_box_no: 9 }),
    expect.objectContaining({ p_raw: "hello", p_storage_number: undefined, p_box_no: undefined }),
  ]);
  expect(headers).toEqual(Array(4).fill("storage_box_scan x-filletry-entry-method: manual"));
});
