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

const inBlastDefault = () => [
  {
    id: "v1",
    blast_in_at: new Date(Date.now() - 125 * 60000).toISOString(),
    weight_lb: 20,
    intake: { number: "INT-0001" },
    asset_tag: { code: "041" },
  },
];

/**
 * Vessel lists by query shape: Locate's exchange list filters on the missing tag, Blast's
 * waiting list `blast_in_at is null`; anything else is the in-blast list.
 */
function setup(
  replies: unknown[] = [],
  lists: { inBlast?: unknown[]; waiting?: unknown[]; exchange?: unknown[] } = {},
) {
  const { inBlast = inBlastDefault(), waiting = [], exchange = [] } = lists;
  const calls: [string, unknown][] = [];
  const from = (name: string) => {
    const mine: string[] = [];
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (calls.push([c, v]), q),
      not: (c: string, op: string, v: unknown) => (calls.push([`not ${c} ${op}`, v]), q),
      is: (c: string, v: unknown) => (calls.push([`is ${c}`, v]), mine.push(`is ${c}`), q),
      in: (c: string, v: unknown) => (calls.push([`in ${c}`, v]), q),
      order: () => q,
      then: (resolve: (r: unknown) => unknown) => {
        const data =
          name !== "vessel"
            ? []
            : mine.includes("is asset_tag_id")
              ? exchange
              : mine.includes("is blast_in_at")
                ? waiting
                : inBlast;
        return Promise.resolve({ data, error: null }).then(resolve);
      },
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

/** An RPC builder for a typed code: thenable, with PostgREST's setHeader. */
function typedRpc(data: unknown) {
  const setHeader = vi.fn();
  const builder = Object.assign(Promise.resolve({ data, error: null }), { setHeader });
  setHeader.mockReturnValue(builder);
  return builder;
}

it("#84 blast Type code: a typed tag takes blast_vessel, flagged manual", async () => {
  const { rpc } = setup();
  render(<BlastStation />);
  await screen.findByText("IN BLAST (1)");
  fireEvent.click(screen.getByRole("button", { name: "Type code" }));
  fireEvent.change(screen.getByLabelText(/Type the code/), { target: { value: "41" } });
  fireEvent.click(screen.getByRole("button", { name: "Enter code" }));
  await waitFor(() =>
    expect(mocks.scan).toHaveBeenCalledWith(
      expect.objectContaining({ raw: "041", station: "blast", entry_method: "manual" }),
    ),
  );
  const call = typedRpc({ ok: false, reason: "Unknown tag" });
  rpc.mockImplementationOnce(() => call as never);
  const reply = await mocks.send!({
    raw: "999",
    station: "blast",
    client_action_id: "typed-1",
    operator_session: null,
    entry_method: "manual",
  });
  expect(reply).toMatchObject({ ok: false, reason: "Unknown tag" });
  expect(rpc).toHaveBeenLastCalledWith(
    "blast_vessel",
    expect.objectContaining({ p_raw: "999", p_client_action_id: "typed-1" }),
  );
  expect(call.setHeader).toHaveBeenCalledWith("x-filletry-entry-method", "manual");
});

it("#84 locate Type code: typed tag then typed location; a phantom location is rejected", async () => {
  const { rpc } = setup();
  render(<LocateStation />);
  fireEvent.click(await screen.findByRole("button", { name: "Type code" }));
  const field = screen.getByLabelText(/Type the code/);
  fireEvent.change(field, { target: { value: "if a 01 1 f" } });
  fireEvent.click(screen.getByRole("button", { name: "Enter code" }));
  await waitFor(() =>
    expect(mocks.scan).toHaveBeenCalledWith(
      expect.objectContaining({ raw: "IF-A-01-1-F", station: "locate", entry_method: "manual" }),
    ),
  );
  const tag = typedRpc({
    ok: true,
    reason: "Vessel 041",
    pending_vessel_raw: "041",
    pending_vessel_id: "v1",
    tag_code: "041",
    intake_number: "INT-0001",
  });
  const phantom = typedRpc({ ok: false, reason: "Unknown location" });
  rpc.mockImplementationOnce(() => tag as never).mockImplementationOnce(() => phantom as never);
  await mocks.send!({ ...request("041", "typed-1"), entry_method: "manual" });
  const reply = await mocks.send!({ ...request("ZZ-9-99-9-F", "typed-2"), entry_method: "manual" });
  expect(reply).toMatchObject({ ok: false, reason: "Unknown location" });
  expect(rpc).toHaveBeenLastCalledWith(
    "locate_scan",
    expect.objectContaining({ p_raw: "ZZ-9-99-9-F", p_pending_vessel_id: "v1" }),
  );
  expect(tag.setHeader).toHaveBeenCalledWith("x-filletry-entry-method", "manual");
  expect(phantom.setHeader).toHaveBeenCalledWith("x-filletry-entry-method", "manual");
  // The vessel stays pending for a retyped location.
  expect(JSON.parse(localStorage.getItem("org:staff:locate")!)).toMatchObject({ id: "v1" });
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();

it("#86 blast lists released-not-blasted vessels, oldest release first; exchange gets Blast in", async () => {
  const { rpc, calls } = setup([{ ok: true, reason: "In blast: Exchange basket · INT-0001" }], {
    waiting: [
      {
        id: "vt",
        weight_lb: 12,
        intake: { number: "INT-0002", blast_at: minutesAgo(5) },
        asset_tag: { code: "042" },
      },
      {
        id: "vx",
        weight_lb: 10,
        intake: { number: "INT-0001", blast_at: minutesAgo(30) },
        asset_tag: null,
      },
    ],
  });
  render(<BlastStation />);
  expect(await screen.findByText("RELEASED, WAITING FOR BLAST-IN (2)")).toBeTruthy();
  const rows = screen.getByRole("region", { name: "Waiting for blast-in" }).querySelectorAll("li");
  expect([...rows].map((r) => r.textContent)).toEqual([
    "Exchange · INT-0001 · 10 lb Blast in",
    "042 · INT-0002 · 12 lb",
  ]);
  expect(calls).toContainEqual(["is blast_in_at", null]);
  expect(calls).toContainEqual(["in intake.state", ["blast_freezer", "stored"]]);
  // Only the exchange basket has a button: tagged vessels are scanned as before.
  const button = screen.getByRole("button", { name: "Blast in exchange basket INT-0001" });
  expect(screen.getAllByRole("button", { name: /^Blast in/ })).toHaveLength(1);
  fireEvent.click(button);
  expect(mocks.scan).toHaveBeenCalledWith(
    expect.objectContaining({ raw: "", vessel_id: "vx", station: "blast" }),
  );
  const reply = await mocks.send!({
    raw: "",
    vessel_id: "vx",
    station: "blast",
    client_action_id: "tap-1",
    operator_session: null,
  });
  expect(reply.reason).toBe("In blast: Exchange basket · INT-0001");
  expect(rpc).toHaveBeenCalledWith("blast_vessel_by_id", {
    p_client_action_id: "tap-1",
    p_vessel_id: "vx",
    p_operator_session: undefined,
  });
});

it("#86 blast shows 'empty' only when nothing is in blast and nothing is waiting", async () => {
  setup([], {
    inBlast: [],
    waiting: [
      { id: "vx", weight_lb: 10, intake: { number: "INT-0001", blast_at: null }, asset_tag: null },
    ],
  });
  render(<BlastStation />);
  expect(await screen.findByText("RELEASED, WAITING FOR BLAST-IN (1)")).toBeTruthy();
  expect(screen.getByText("IN BLAST (0)")).toBeTruthy();
  expect(screen.queryByText("Blast freezer empty")).toBeNull();
  cleanup();
  setup([], { inBlast: [], waiting: [] });
  render(<BlastStation />);
  expect(await screen.findByText("Blast freezer empty")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Waiting for blast-in" })).toBeNull();
});

it("#86 locate: exchange basket selected by tap, then the location scan places it by id", async () => {
  const { rpc, calls } = setup(
    [
      {
        ok: true,
        reason: "Exchange basket · INT-0001 — scan a location",
        vessel_id: "vx",
        tag_code: null,
        is_exchange: true,
        intake_number: "INT-0001",
        species: "Reds",
        placed: false,
        reset: false,
        pending_vessel_raw: null,
        pending_vessel_id: "vx",
      },
      { ok: true, reason: "Placed Exchange basket → IF-A-01-1-F", placed: true, reset: true },
    ],
    {
      exchange: [
        { id: "vx", weight_lb: 10, blast_in_at: minutesAgo(125), intake: { number: "INT-0001" } },
      ],
    },
  );
  render(<LocateStation />);
  expect(await screen.findByText("EXCHANGE BASKETS — NO TAG (1)")).toBeTruthy();
  expect(screen.getByText(/Exchange · INT-0001 · 10 lb · in blast 2h 0[45]m/)).toBeTruthy();
  expect(calls).toContainEqual(["is asset_tag_id", null]);
  expect(calls).toContainEqual(["is location_id", null]);
  fireEvent.click(screen.getByRole("button", { name: "Select exchange basket INT-0001" }));
  expect(mocks.scan).toHaveBeenCalledWith(
    expect.objectContaining({ raw: "", vessel_id: "vx", station: "locate" }),
  );
  await mocks.send!({ ...request("", "tap-1"), vessel_id: "vx" });
  expect(rpc).toHaveBeenLastCalledWith("locate_vessel_by_id", {
    p_client_action_id: "tap-1",
    p_vessel_id: "vx",
    p_operator_session: undefined,
  });
  expect(await screen.findByText("STEP 2 — SCAN LOCATION")).toBeTruthy();
  expect(screen.getByText("Exchange basket")).toBeTruthy();
  expect(screen.getByText("INT-0001")).toBeTruthy();
  // The location is scanned (or typed) as for a tagged vessel; the pending basket is its id.
  await mocks.send!(request("FL:LOC:demo:IF-A-01-1-F", "loc-1"));
  expect(rpc).toHaveBeenLastCalledWith(
    "locate_scan",
    expect.objectContaining({
      p_raw: "FL:LOC:demo:IF-A-01-1-F",
      p_pending_vessel_raw: undefined,
      p_pending_vessel_id: "vx",
    }),
  );
  expect(await screen.findByText("STEP 1 — SCAN VESSEL TAG")).toBeTruthy();
});

it("#86 locate holds a tapped exchange basket by id with no tag text", () => {
  expect(
    nextPending(null, {
      ok: true,
      reason: "Exchange basket · INT-0001 — scan a location",
      tag_code: null,
      intake_number: "INT-0001",
      pending_vessel_raw: null,
      pending_vessel_id: "vx",
    }),
  ).toEqual({ id: "vx", raw: "", tag: null, intake: "INT-0001", species: null });
});
