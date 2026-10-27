// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ScanReply, ScanRequest } from "@/src/components/station/scan-queue";
import { BlastStation } from "./blast-station";
import { LocateStation, nextPending } from "./locate-station";
import { freezerReply, timeIn } from "./use-freezer-operator";

const mocks = vi.hoisted(() => ({
  session: null as unknown,
  send: null as null | ((r: ScanRequest) => Promise<ScanReply>),
  scan: vi.fn(),
}));
vi.mock("@/components/intake/use-station-session", () => ({
  useStationSession: () => ({ session: mocks.session, loaded: true }),
}));
vi.mock("@/src/components/station/use-scan-action", () => ({
  useScanAction: (_scope: string, send: (r: ScanRequest) => Promise<ScanReply>) => {
    mocks.send = send;
    return { scan: mocks.scan, pending: 0, feedback: null };
  },
}));
vi.mock("@/src/components/station/scan-feedback", () => ({ ScanFeedback: () => null }));

beforeEach(() => {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: async (_name: string, work: () => unknown) => work() },
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

function setup(replies: unknown[] = []) {
  const vessels = [
    {
      id: "v1",
      blast_in_at: new Date(Date.now() - 125 * 60000).toISOString(),
      weight_lb: 20,
      intake: { number: "INT-0001" },
      asset_tag: { code: "041" },
    },
  ];
  const calls: [string, unknown][] = [];
  const from = (name: string) => {
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (calls.push([c, v]), q),
      not: (c: string, op: string, v: unknown) => (calls.push([`not ${c} ${op}`, v]), q),
      is: (c: string, v: unknown) => (calls.push([`is ${c}`, v]), q),
      order: () => q,
      then: (resolve: (r: unknown) => unknown) =>
        Promise.resolve({ data: name === "vessel" ? vessels : [], error: null }).then(resolve),
    };
    return q;
  };
  const channel = { on: () => channel, subscribe: () => channel };
  const rpc = vi.fn(async () => ({
    data: replies.shift() ?? { ok: true, reason: "Accepted" },
    error: null,
  }));
  mocks.session = {
    client: { from, rpc, channel: () => channel, removeChannel: vi.fn() },
    claims: { orgId: "org", userId: "staff", appRole: "staff" },
    siteName: "Main",
  };
  return { rpc, calls };
}
const request = (raw: string, id: string): ScanRequest => ({
  raw,
  station: "locate",
  client_action_id: id,
  operator_session: null,
});

it("WP13 blast queue lists occupied vessels in blast with time-in", async () => {
  const { calls } = setup();
  render(<BlastStation />);
  expect(await screen.findByText(/041 · INT-0001 · 20 lb · 2h 0[45]m/)).toBeTruthy();
  expect(screen.getByText("IN BLAST (1)")).toBeTruthy();
  expect(calls).toContainEqual(["lifecycle_state", "occupied"]);
  expect(calls).toContainEqual(["is stored_at", null]);
});

it("WP13 blast scan posts the raw tag with its idempotency key", async () => {
  const { rpc } = setup([{ ok: true, reason: "In blast: 041 · INT-0001" }]);
  render(<BlastStation />);
  await screen.findByText("IN BLAST (1)");
  const reply = await mocks.send!({ ...request("FL:TAG:demo:041", "blast-1"), station: "blast" });
  expect(reply.reason).toBe("In blast: 041 · INT-0001");
  expect(rpc).toHaveBeenCalledWith("blast_vessel", {
    p_client_action_id: "blast-1",
    p_raw: "FL:TAG:demo:041",
    p_operator_session: undefined,
  });
});

it("WP13 locate two-step loop: tag → shows vessel, location → placed and reset", async () => {
  const { rpc } = setup([
    {
      ok: true,
      reason: "041 · INT-0001 — scan a location",
      tag_code: "041",
      intake_number: "INT-0001",
      species: "Reds",
      placed: false,
      pending_vessel_raw: "FL:TAG:demo:041",
      pending_vessel_id: "vessel-a",
    },
    { ok: true, reason: "Placed 041 → IF-A-01-1-F", placed: true, pending_vessel_raw: null },
  ]);
  render(<LocateStation />);
  expect(screen.getByText("STEP 1 — SCAN VESSEL TAG")).toBeTruthy();
  await mocks.send!(request("FL:TAG:demo:041", "loc-1"));
  expect(await screen.findByText("STEP 2 — SCAN LOCATION")).toBeTruthy();
  expect(screen.getByText("INT-0001")).toBeTruthy();
  expect(screen.getByText("Reds")).toBeTruthy();
  await mocks.send!(request("FL:LOC:demo:IF-A-01-1-F", "loc-2"));
  expect(rpc.mock.calls[1]).toEqual([
    "locate_scan",
    expect.objectContaining({
      p_client_action_id: "loc-2",
      p_raw: "FL:LOC:demo:IF-A-01-1-F",
      p_pending_vessel_raw: "FL:TAG:demo:041",
      p_pending_vessel_id: "vessel-a",
    }),
  ]);
  expect(await screen.findByText("STEP 1 — SCAN VESSEL TAG")).toBeTruthy();
  expect(localStorage.getItem("org:staff:locate")).toBe("null");
});

it("WP13 locate keeps the vessel pending after a rejected (archived) location", () => {
  const current = { id: "vessel-a", raw: "041", tag: "041", intake: "INT-0001", species: null };
  expect(
    nextPending(current, {
      ok: false,
      reason: "location IF-A-02-2-R is archived and cannot be bound",
      placed: false,
      pending_vessel_raw: "041",
    }),
  ).toBe(current);
});

it("WP13 locate resets when the tag was released and rebound between scans", () => {
  const current = { id: "vessel-a", raw: "041", tag: "041", intake: "INT-0001", species: null };
  expect(
    nextPending(current, {
      ok: false,
      reason: "Selected vessel changed since its tag was scanned; scan the tag again",
      placed: false,
      reset: true,
      pending_vessel_raw: null,
      pending_vessel_id: null,
    }),
  ).toBeNull();
});

it("WP13 locate drops a stored pending tag that has no vessel identity", () => {
  localStorage.setItem(
    "org:staff:locate",
    JSON.stringify({ raw: "041", tag: "041", intake: "INT-0001", species: null }),
  );
  setup();
  render(<LocateStation />);
  expect(screen.getByText("STEP 1 — SCAN VESSEL TAG")).toBeTruthy();
});

it("WP13 locate can drop the pending vessel", async () => {
  setup();
  localStorage.setItem(
    "org:staff:locate",
    JSON.stringify({ id: "vessel-a", raw: "041", tag: "041", intake: "INT-0001", species: null }),
  );
  render(<LocateStation />);
  fireEvent.click(await screen.findByRole("button", { name: "Scan a different vessel" }));
  await waitFor(() => expect(screen.getByText("STEP 1 — SCAN VESSEL TAG")).toBeTruthy());
});

it("WP13 malformed freezer reply is refused", () => {
  expect(() => freezerReply({ ok: "yes" })).toThrow();
  expect(timeIn("2026-10-27T10:00:00Z", new Date("2026-10-27T12:05:00Z"))).toBe("2h 05m");
});
