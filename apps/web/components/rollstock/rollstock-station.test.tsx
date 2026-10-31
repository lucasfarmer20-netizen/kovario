// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  ScanQueue,
  type PendingScan,
  type QueueLock,
  type ScanRequest,
  type ScanReply,
} from "@/src/components/station/scan-queue";
import { RollstockStation, rollstockReply } from "./rollstock-station";
const mocks = vi.hoisted(() => ({
  session: null as unknown,
  pending: 0,
  send: null as null | ((r: ScanRequest) => Promise<ScanReply>),
  scan: vi.fn(),
  /** The station's realtime reload (what a postgres change triggers). */
  reload: null as null | (() => void),
  tables: {} as Record<string, unknown>,
}));
vi.mock("@/components/intake/use-station-session", () => ({
  useStationSession: () => ({ session: mocks.session, loaded: true }),
}));
vi.mock("@/src/components/station/use-scan-action", () => ({
  useScanAction: (_scope: string, send: (r: ScanRequest) => Promise<ScanReply>) => {
    mocks.send = send;
    return { scan: mocks.scan, pending: mocks.pending, feedback: null };
  },
}));
vi.mock("@/src/components/station/scan-feedback", () => ({ ScanFeedback: () => null }));

beforeEach(() => {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (_name: string, work: () => unknown) => work(),
    },
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
  mocks.pending = 0;
});
const OPEN_I1 = "Order INT-0001 · tote 1 of 2";
function setup({ role = "staff", scanned = 1, nextUp = true, resume = false } = {}) {
  localStorage.setItem("org:staff:rollstock", "i1");
  const tables: Record<string, unknown> = {
    intake: [
      {
        id: "i1",
        number: "INT-0001",
        state: "rollstock",
        tote_count: 2,
        intake_line: [{ species_code: "salmon_reds" }],
        dirty_fish: true,
        processing_notes: "Keep skin on",
      },
      ...(nextUp
        ? [
            {
              id: "i2",
              number: "INT-0002",
              intake_at: "2026-10-25T00:00:00Z",
              state: "processing",
              tote_count: 1,
              intake_line: [],
            },
          ]
        : []),
      ...(resume
        ? [
            {
              id: "i3",
              number: "INT-0003",
              state: "rollstock",
              tote_count: 1,
              intake_line: [],
            },
          ]
        : []),
    ],
    rollstock_tote_progress: [{ intake_id: "i1", scanned }],
  };
  mocks.tables = tables;
  const from = (name: string) => {
    const q = {
      select: () => q,
      in: () => q,
      order: () => q,
      then: (resolve: (r: unknown) => unknown) =>
        Promise.resolve({ data: mocks.tables[name], error: null }).then(resolve),
    };
    return q;
  };
  const channel = {
    on: (_event: string, _filter: unknown, callback: () => void) => {
      mocks.reload = callback;
      return channel;
    },
    subscribe: () => channel,
  };
  const rpc = vi.fn(async () => ({
    data: { ok: true, reason: "Tote accepted", open_intake_id: "i2" },
    error: null,
  }));
  mocks.session = {
    client: { from, rpc, channel: () => channel, removeChannel: vi.fn() },
    claims: { orgId: "org", userId: "staff", appRole: role },
    siteName: "Main",
  };
  return rpc;
}
it("WP11 OPEN panel shows tote progress species notes and NEXT UP", async () => {
  setup();
  render(<RollstockStation />);
  expect(await screen.findByRole("heading", { name: OPEN_I1 })).toBeTruthy();
  expect(screen.getByText("Reds")).toBeTruthy();
  expect(screen.getByText("DIRTY")).toBeTruthy();
  expect(screen.getByText("Keep skin on")).toBeTruthy();
  const nextUp = screen.getByRole("region", { name: "Next up" });
  expect(within(nextUp).getByText("INT-0002")).toBeTruthy();
  // De-emphasised: outlined while scanning leads.
  expect(screen.getByRole("button", { name: "Finish queue" }).className).toContain(
    "st-btn-secondary",
  );
  expect(screen.getByTestId("next-step").textContent).toBe("Scan the next tote");
});
it("#98 with no order open the next step is Scan a tote, and Finish says why it is disabled", async () => {
  setup();
  localStorage.setItem("org:staff:rollstock", "");
  render(<RollstockStation />);
  await screen.findByText("Scan a tote to open an order.");
  expect(screen.getByTestId("next-step").textContent).toBe("Scan a tote");
  expect(screen.getByText("Scan a tote first")).toBeTruthy();
});
it("WP11 finish sends current intake with idempotency key and blocks pending scans", async () => {
  const rpc = setup();
  const view = render(<RollstockStation />);
  await screen.findByRole("heading", { name: OPEN_I1 });
  mocks.pending = 1;
  view.rerender(<RollstockStation />);
  expect((screen.getByRole("button", { name: "Finish queue" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  mocks.pending = 0;
  view.rerender(<RollstockStation />);
  fireEvent.click(screen.getByRole("button", { name: "Finish queue" }));
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "rollstock_scan_advance",
      expect.objectContaining({
        p_raw: null,
        p_open_intake_id: "i1",
        p_client_action_id: expect.any(String),
      }),
    ),
  );
});
it("WP11 FIFO two-scan delivery uses previous server response without waiting for a render", async () => {
  const rpc = setup();
  render(<RollstockStation />);
  await screen.findByRole("heading", { name: OPEN_I1 });
  const send = mocks.send!;
  await send({
    raw: "FL:TOTE:INT-0002:1",
    station: "rollstock",
    client_action_id: "scan-001",
    operator_session: null,
  });
  await send({
    raw: "FL:TOTE:INT-0003:1",
    station: "rollstock",
    client_action_id: "scan-002",
    operator_session: null,
  });
  expect(rpc.mock.calls[0]).toEqual([
    "rollstock_scan_advance",
    expect.objectContaining({ p_open_intake_id: "i1" }),
  ]);
  expect(rpc.mock.calls[1]).toEqual([
    "rollstock_scan_advance",
    expect.objectContaining({ p_open_intake_id: "i2" }),
  ]);
  expect(localStorage.getItem("org:staff:rollstock")).toBe("i2");
});
it("WP11 Finish reads shared open intake after acquiring the delivery lock", async () => {
  const rpc = setup();
  render(<RollstockStation />);
  await screen.findByRole("heading", { name: OPEN_I1 });
  const requestLock = vi.fn(async (_name: string, work: () => unknown) => {
    // Another consumer has advanced the selection while Finish waited for its lock.
    localStorage.setItem("org:staff:rollstock", "i2");
    return work();
  });
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: requestLock },
  });
  fireEvent.click(screen.getByRole("button", { name: "Finish queue" }));
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "rollstock_scan_advance",
      expect.objectContaining({ p_raw: null, p_open_intake_id: "i2" }),
    ),
  );
  expect(requestLock).toHaveBeenCalledWith(
    "scan-delivery:org:staff:rollstock",
    expect.any(Function),
  );
});
it("WP11 malformed response cannot silently clear the open intake", () => {
  expect(() => rollstockReply({ ok: true, reason: "Accepted" })).toThrow();
});
it("WP11 two queue consumers share open intake before storage events and synchronize panels", async () => {
  const rpc = setup();
  localStorage.removeItem("org:staff:rollstock");
  const first = render(<RollstockStation />);
  const sendA = mocks.send!;
  const second = render(<RollstockStation />);
  const sendB = mocks.send!;
  await waitFor(() => expect(within(first.container).getByText(/INT-0002/)).toBeTruthy());
  rpc.mockResolvedValueOnce({
    data: { ok: true, reason: "Tote accepted", open_intake_id: "i1" },
    error: null,
  });
  rpc.mockResolvedValueOnce({
    data: { ok: true, reason: "Tote accepted", open_intake_id: "i1" },
    error: null,
  });
  // Both consumers use one durable queue and the same cross-tab delivery lock.
  let rows: PendingScan[] = [];
  const store = {
    read: async () => structuredClone(rows),
    write: async (next: PendingScan[]) => {
      rows = structuredClone(next);
    },
  };
  const serialLock = (): QueueLock => {
    let tail: Promise<unknown> = Promise.resolve();
    return (work) => {
      const next = tail.then(work);
      tail = next.catch(() => undefined);
      return next;
    };
  };
  const storageLock = serialLock();
  const deliveryLock = serialLock();
  const a = new ScanQueue(
    store,
    sendA,
    () => undefined,
    () => undefined,
    Date.now,
    storageLock,
    deliveryLock,
  );
  const b = new ScanQueue(
    store,
    sendB,
    () => undefined,
    () => undefined,
    Date.now,
    storageLock,
    deliveryLock,
  );
  const request = (id: string, raw: string): ScanRequest => ({
    client_action_id: id,
    raw,
    station: "rollstock",
    operator_session: null,
  });
  await act(async () => {
    await a.enqueue(request("consumer-a-first", "FL:TOTE:INT-0001:1"));
    await a.drain();
    // Do not deliver a storage event yet: consumer B still displays no open intake.
    await b.enqueue(request("consumer-b-same", "FL:TOTE:INT-0001:2"));
    await b.drain();
    await a.enqueue(request("consumer-a-next", "FL:TOTE:INT-0002:1"));
    await a.drain();
  });
  expect(rpc.mock.calls).toEqual([
    ["rollstock_scan_advance", expect.objectContaining({ p_open_intake_id: null })],
    ["rollstock_scan_advance", expect.objectContaining({ p_open_intake_id: "i1" })],
    ["rollstock_scan_advance", expect.objectContaining({ p_open_intake_id: "i1" })],
  ]);
  expect(await store.read()).toEqual([]);
  expect(localStorage.getItem("org:staff:rollstock")).toBe("i2");
  expect(within(second.container).getByRole("heading", { name: /^Order INT-0001/ })).toBeTruthy();
  act(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "org:staff:rollstock",
        newValue: "i2",
        storageArea: localStorage,
      }),
    ),
  );
  expect(within(second.container).getByRole("heading", { name: /^Order INT-0002/ })).toBeTruthy();
  // Clearing shared selection also updates both consumers.
  localStorage.removeItem("org:staff:rollstock");
  act(() =>
    window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage })),
  );
  expect(within(first.container).getByText("Scan a tote to open an order.")).toBeTruthy();
  expect(within(second.container).getByText("Scan a tote to open an order.")).toBeTruthy();
});

it("#84 Enter manually: a typed tote short code takes the rollstock scan path, flagged manual", async () => {
  const rpc = setup();
  render(<RollstockStation />);
  await screen.findByRole("heading", { name: OPEN_I1 });
  fireEvent.click(screen.getByRole("button", { name: "Enter manually" }));
  fireEvent.change(screen.getByLabelText("Tote number (INT-0002-1)"), {
    target: { value: "INT-0002-1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Enter" }));
  await waitFor(() =>
    expect(mocks.scan).toHaveBeenCalledWith(
      expect.objectContaining({
        raw: "FL:TOTE:INT-0002:1",
        station: "rollstock",
        entry_method: "manual",
      }),
    ),
  );
  const setHeader = vi.fn();
  rpc.mockImplementationOnce(() => {
    const builder = Object.assign(
      Promise.resolve({
        data: { ok: false, reason: "Unknown tote", open_intake_id: "i1" },
        error: null,
      }),
      { setHeader },
    );
    setHeader.mockReturnValue(builder);
    return builder as never;
  });
  const reply = await mocks.send!({
    raw: "FL:TOTE:INT-9999:1",
    station: "rollstock",
    client_action_id: "typed-1",
    operator_session: null,
    entry_method: "manual",
  });
  expect(reply).toMatchObject({ ok: false, reason: "Unknown tote" });
  expect(rpc).toHaveBeenLastCalledWith(
    "rollstock_scan_advance",
    expect.objectContaining({ p_raw: "FL:TOTE:INT-9999:1", p_client_action_id: "typed-1" }),
  );
  expect(setHeader).toHaveBeenCalledWith("x-filletry-entry-method", "manual");
});

const MISSING = { ok: false, reason: "Missing totes: 1 of 2 scanned", open_intake_id: "i1" };
/** Opens INT-0001 (1 of 2 totes), then delivers a tote of INT-0002 that the server refuses. */
async function refuseNextTote(role = "staff", resume = false) {
  const rpc = setup({ role, resume });
  render(<RollstockStation />);
  await screen.findByRole("heading", { name: OPEN_I1 });
  rpc.mockResolvedValueOnce({ data: MISSING, error: null });
  await act(async () => {
    await mocks.send!({
      raw: "FL:TOTE:INT-0002:1",
      station: "rollstock",
      client_action_id: "scan-next",
      operator_session: null,
    });
  });
  return rpc;
}
function typeReason(panel: HTMLElement, value: string) {
  fireEvent.click(within(panel).getByRole("button", { name: "Add reason" }));
  fireEvent.change(within(panel).getByLabelText("Override reason"), { target: { value } });
  fireEvent.click(within(panel).getByRole("button", { name: "Done" }));
}
it("#128 a tote refused for missing totes puts the manager path at the top, naming both orders", async () => {
  await refuseNextTote();
  const panel = await screen.findByRole("region", { name: "Missing totes" });
  expect(panel.textContent).toContain("then INT-0002 opens");
  expect(screen.getByTestId("next-step").textContent).toBe("Scan the missing tote for INT-0001");
  // Approve waits for a reason, and says so.
  const approve = within(panel).getByRole("button", { name: /Approve incomplete totes/ });
  expect((approve as HTMLButtonElement).disabled).toBe(true);
  expect(within(panel).getByText("Enter a reason first")).toBeTruthy();
});
it("#128 the reason is typed with the scanner paused; a manager account approves without a PIN and the refused order opens", async () => {
  const rpc = await refuseNextTote("manager");
  const panel = await screen.findByRole("region", { name: "Missing totes" });
  fireEvent.click(within(panel).getByRole("button", { name: "Add reason" }));
  expect((screen.getByLabelText("Station scanner") as HTMLInputElement).disabled).toBe(true);
  fireEvent.change(within(panel).getByLabelText("Override reason"), {
    target: { value: "Tote 2 lost on the line" },
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Done" }));
  expect((screen.getByLabelText("Station scanner") as HTMLInputElement).disabled).toBe(false);
  rpc.mockResolvedValueOnce({
    data: { ok: true, reason: "Tote accepted", open_intake_id: "i2" },
    error: null,
  });
  fireEvent.click(within(panel).getByRole("button", { name: /Approve incomplete totes/ }));
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "rollstock_scan_advance",
      expect.objectContaining({
        p_raw: "FL:TOTE:INT-0002:1",
        p_open_intake_id: "i1",
        p_override_reason: "Tote 2 lost on the line",
        p_elevation_token: undefined,
      }),
    ),
  );
  expect(screen.queryByRole("region", { name: "Manager PIN" })).toBeNull();
  expect(
    await screen.findByText("Order INT-0001 sent to reconcile; INT-0002 is open"),
  ).toBeTruthy();
  expect(localStorage.getItem("org:staff:rollstock")).toBe("i2");
});
it("#128 staff approval asks for a manager PIN", async () => {
  await refuseNextTote();
  const panel = await screen.findByRole("region", { name: "Missing totes" });
  typeReason(panel, "Tote lost");
  fireEvent.click(within(panel).getByRole("button", { name: /Approve incomplete totes/ }));
  expect(screen.getByRole("dialog", { name: "Manager PIN" })).toBeTruthy();
});
it("#128 Finish refused for missing totes opens the manager path too", async () => {
  const rpc = setup();
  render(<RollstockStation />);
  await screen.findByRole("heading", { name: OPEN_I1 });
  rpc.mockResolvedValueOnce({ data: MISSING, error: null });
  fireEvent.click(screen.getByRole("button", { name: "Finish queue" }));
  const panel = await screen.findByRole("region", { name: "Missing totes" });
  expect(panel.textContent).not.toContain("opens");
  expect(screen.getByText("Missing totes: 1 of 2 scanned")).toBeTruthy();
});
it("#128 every tote in: scanning leads while orders are next up, then Finish queue is the step and the filled button", async () => {
  setup({ scanned: 2 });
  const view = render(<RollstockStation />);
  await screen.findByRole("heading", { name: "Order INT-0001 · tote 2 of 2" });
  expect(screen.getByTestId("next-step").textContent).toBe("Scan the next tote");
  expect(screen.getByRole("button", { name: "Finish queue" }).className).toContain(
    "st-btn-secondary",
  );
  view.unmount();
  setup({ scanned: 2, nextUp: false });
  render(<RollstockStation />);
  await screen.findByRole("heading", { name: "Order INT-0001 · tote 2 of 2" });
  expect(screen.getByTestId("next-step").textContent).toBe("Tap Finish queue");
  expect(screen.getByRole("button", { name: "Finish queue" }).className).not.toContain(
    "st-btn-secondary",
  );
  expect(screen.getByText("Queue empty")).toBeTruthy();
});
it("#128 a remembered open order that has moved on shows as not found, with Clear as the step", async () => {
  setup();
  localStorage.setItem("org:staff:rollstock", "gone");
  render(<RollstockStation />);
  expect(await screen.findByText("Open order not found")).toBeTruthy();
  expect(screen.getByTestId("next-step").textContent).toBe("Tap Clear stale open order");
  fireEvent.click(screen.getByRole("button", { name: "Clear stale open order" }));
  await screen.findByText("Scan a tote to open an order.");
  expect(localStorage.getItem("org:staff:rollstock")).toBe("");
});
const scanner = () => screen.getByLabelText("Station scanner") as HTMLInputElement;
it("#128 resuming another order while the reason is being typed ends the editing: the scanner and Enter manually come back", async () => {
  await refuseNextTote("staff", true);
  const panel = await screen.findByRole("region", { name: "Missing totes" });
  fireEvent.click(within(panel).getByRole("button", { name: "Add reason" }));
  fireEvent.change(within(panel).getByLabelText("Override reason"), {
    target: { value: "Tote lost" },
  });
  expect(scanner().disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Resume INT-0003" }));
  await screen.findByRole("heading", { name: "Order INT-0003 · tote 0 of 1" });
  expect(screen.queryByRole("region", { name: "Missing totes" })).toBeNull();
  expect(scanner().disabled).toBe(false);
  expect(
    (screen.getByRole("button", { name: "Enter manually" }) as HTMLButtonElement).disabled,
  ).toBe(false);
  // Back on INT-0001 its refusal still stands, so the panel returns: editing ended, the reason
  // cleared rather than carried over.
  fireEvent.click(screen.getByRole("button", { name: "Resume INT-0001" }));
  await screen.findByRole("heading", { name: OPEN_I1 });
  const again = await screen.findByRole("region", { name: "Missing totes" });
  expect(within(again).getByRole("button", { name: "Add reason" })).toBeTruthy();
  expect(within(again).getByText("Enter a reason first")).toBeTruthy();
  expect(scanner().disabled).toBe(false);
});
it("#128 a refresh that finds the open order gone while the reason is being typed ends the editing", async () => {
  await refuseNextTote();
  const panel = await screen.findByRole("region", { name: "Missing totes" });
  fireEvent.click(within(panel).getByRole("button", { name: "Add reason" }));
  expect(scanner().disabled).toBe(true);
  // Another station moved INT-0001 on: it is no longer listed.
  mocks.tables = {
    ...mocks.tables,
    intake: (mocks.tables.intake as { id: string }[]).filter((i) => i.id !== "i1"),
  };
  await act(async () => {
    mocks.reload!();
  });
  expect(await screen.findByText("Open order not found")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Missing totes" })).toBeNull();
  expect(scanner().disabled).toBe(false);
});
