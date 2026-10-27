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
function setup() {
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
      {
        id: "i2",
        number: "INT-0002",
        intake_at: "2026-10-25T00:00:00Z",
        state: "processing",
        tote_count: 1,
        intake_line: [],
      },
    ],
    rollstock_tote_progress: [{ intake_id: "i1", scanned: 1 }],
  };
  const from = (name: string) => {
    const q = {
      select: () => q,
      in: () => q,
      order: () => q,
      then: (resolve: (r: unknown) => unknown) =>
        Promise.resolve({ data: tables[name], error: null }).then(resolve),
    };
    return q;
  };
  const channel = { on: () => channel, subscribe: () => channel };
  const rpc = vi.fn(async () => ({
    data: { ok: true, reason: "Tote accepted", open_intake_id: "i2" },
    error: null,
  }));
  mocks.session = {
    client: { from, rpc, channel: () => channel, removeChannel: vi.fn() },
    claims: { orgId: "org", userId: "staff", appRole: "staff" },
    siteName: "Main",
  };
  return rpc;
}
it("WP11 OPEN panel shows tote progress species notes and NEXT UP", async () => {
  setup();
  render(<RollstockStation />);
  expect(await screen.findByText("Totes 1/2")).toBeTruthy();
  expect(screen.getByText("salmon_reds")).toBeTruthy();
  expect(screen.getByText("Keep skin on")).toBeTruthy();
  expect(screen.getByText("NEXT UP")).toBeTruthy();
  expect(screen.getByText(/INT-0002/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Finish queue" }).className).toContain("opacity-70");
});
it("WP11 finish sends current intake with idempotency key and blocks pending scans", async () => {
  const rpc = setup();
  const view = render(<RollstockStation />);
  await screen.findByText("Totes 1/2");
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
  await screen.findByText("Totes 1/2");
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
  await screen.findByText("Totes 1/2");
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
  expect(within(second.container).getByRole("heading", { name: "INT-0001" })).toBeTruthy();
  act(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "org:staff:rollstock",
        newValue: "i2",
        storageArea: localStorage,
      }),
    ),
  );
  expect(within(second.container).getByRole("heading", { name: "INT-0002" })).toBeTruthy();
  // Clearing shared selection also updates both consumers.
  localStorage.removeItem("org:staff:rollstock");
  act(() =>
    window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage })),
  );
  expect(within(first.container).getByText("Scan a numbered tote to open an intake.")).toBeTruthy();
  expect(
    within(second.container).getByText("Scan a numbered tote to open an intake."),
  ).toBeTruthy();
});
