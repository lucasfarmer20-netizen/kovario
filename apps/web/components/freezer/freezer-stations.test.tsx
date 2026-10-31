// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ScanReply, ScanRequest } from "@/src/components/station/scan-queue";
import { BlastStation } from "./blast-station";
import { LocateStation, nextPending } from "./locate-station";
import { freezerReply, timeIn } from "./use-freezer-operator";

const mocks = vi.hoisted(() => ({
  session: null as unknown,
  send: null as null | ((r: ScanRequest) => Promise<ScanReply>),
  // Resolves true: the request was queued (useScanAction).
  scan: vi.fn<(request: ScanRequest) => Promise<boolean>>(async () => true),
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
  lists: { inBlast?: unknown[]; waiting?: unknown[]; exchange?: unknown[]; lines?: unknown[] } = {},
) {
  const { inBlast = inBlastDefault(), waiting = [], exchange = [], lines = [] } = lists;
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
          name === "now_in_blast"
            ? lines
            : name !== "vessel"
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
/** Each row of a list region, as one line of text (a basket row reads "Basket 041 · INT-0001 · …"). */
const rows = (name: string) =>
  [...screen.getByRole("region", { name }).querySelectorAll("li")].map((li) => li.textContent);
/** The Locate step card's heading. */
const locateHeading = () =>
  within(screen.getByRole("region", { name: "Locate step" })).getByRole("heading").textContent;

const request = (raw: string, id: string): ScanRequest => ({
  raw,
  station: "locate",
  client_action_id: id,
  operator_session: null,
});

it("WP13 blast queue lists occupied vessels in blast with time-in", async () => {
  const { calls } = setup();
  render(<BlastStation />);
  await screen.findByRole("region", { name: "In blast" });
  expect(rows("In blast")).toEqual([
    expect.stringMatching(/^Basket 041 · INT-0001 · 20 lb · in blast 2h 0[45]m$/),
  ]);
  expect(within(screen.getByRole("region", { name: "In blast" })).getByText("1")).toBeTruthy();
  expect(screen.getByTestId("next-step").textContent).toBe("Scan a basket going into the blast");
  expect(calls).toContainEqual(["lifecycle_state", "occupied"]);
  expect(calls).toContainEqual(["is stored_at", null]);
});

it("#87 blast shows a 'now in blast' line per intake, in rollstock order, colour-coded", async () => {
  const line = (n: string, at: string | null, pct: number | null, band: string) => ({
    intake_id: n,
    intake_number: n,
    variance_pct: pct,
    band,
    limit_pct: 15,
    rollstock_opened_at: at,
    rollstock_scan_id: `s-${n}`,
  });
  setup([], {
    lines: [
      line("INT-2121", "2026-07-20T08:05:00+00:00", -12, "near"),
      line("INT-2122", null, null, "unknown"),
      line("INT-2120", "2026-07-20T08:00:00+00:00", 14, "near"),
      line("INT-2119", "2026-07-20T07:55:00+00:00", 40, "over"),
      line("INT-2118", "2026-07-20T07:50:00+00:00", 1.25, "within"),
    ],
  });
  render(<BlastStation />);
  const section = await screen.findByRole("region", { name: "Now in blast" });
  await waitFor(() => expect(section.querySelectorAll("li")).toHaveLength(5));
  const items = [...section.querySelectorAll("li")];
  expect(items.map((li) => li.textContent)).toEqual([
    "INT-2118 is in the blast · variance +1.3% · within limit",
    "INT-2119 is in the blast · variance +40% · over limit",
    "INT-2120 is in the blast · variance +14% · near limit",
    "INT-2121 is in the blast · variance −12% · near limit",
    "INT-2122 is in the blast · variance — · no estimate",
  ]);
  expect(items.map((li) => li.className)).toEqual([
    "station-band station-band-within",
    "station-band station-band-over",
    "station-band station-band-near",
    "station-band station-band-near",
    "station-band station-band-unknown",
  ]);
});

it("WP13 blast scan posts the raw tag with its idempotency key", async () => {
  const { rpc } = setup([{ ok: true, reason: "Basket 041 in blast · INT-0001" }]);
  render(<BlastStation />);
  await screen.findByRole("region", { name: "In blast" });
  const reply = await mocks.send!({ ...request("FL:TAG:demo:041", "blast-1"), station: "blast" });
  expect(reply.reason).toBe("Basket 041 in blast · INT-0001");
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
      reason: "Basket 041 · INT-0001. Scan a location.",
      tag_code: "041",
      intake_number: "INT-0001",
      species: "Reds",
      placed: false,
      pending_vessel_raw: "FL:TAG:demo:041",
      pending_vessel_id: "vessel-a",
    },
    {
      ok: true,
      reason: "Basket 041 placed at IF-A-01-1-F",
      placed: true,
      pending_vessel_raw: null,
    },
  ]);
  render(<LocateStation />);
  expect(await screen.findByRole("heading", { name: "No basket scanned" })).toBeTruthy();
  expect(screen.getByTestId("next-step").textContent).toBe("Scan basket");
  expect(
    within(screen.getByRole("list", { name: "Steps" }))
      .getByText("Scan basket")
      .closest("li")!
      .getAttribute("aria-current"),
  ).toBe("step");
  await mocks.send!(request("FL:TAG:demo:041", "loc-1"));
  expect(await screen.findByRole("heading", { name: "Basket 041" })).toBeTruthy();
  expect(screen.getByTestId("next-step").textContent).toBe("Scan location for basket 041");
  expect(
    within(screen.getByRole("list", { name: "Steps" }))
      .getByText("Scan location")
      .closest("li")!
      .getAttribute("aria-current"),
  ).toBe("step");
  // Step 1 is ticked off (#129): a check, still numbered for screen readers.
  expect(
    within(screen.getByRole("list", { name: "Steps" }))
      .getByText("Scan basket")
      .closest("li")!
      .getAttribute("data-state"),
  ).toBe("done");
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
  expect(await screen.findByRole("heading", { name: "No basket scanned" })).toBeTruthy();
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
      reason: "The selected basket changed since it was scanned. Scan the basket again.",
      placed: false,
      reset: true,
      pending_vessel_raw: null,
      pending_vessel_id: null,
    }),
  ).toBeNull();
});

it("WP13 locate drops a stored pending tag that has no vessel identity", async () => {
  localStorage.setItem(
    "org:staff:locate",
    JSON.stringify({ raw: "041", tag: "041", intake: "INT-0001", species: null }),
  );
  setup();
  render(<LocateStation />);
  expect(await screen.findByRole("heading", { name: "No basket scanned" })).toBeTruthy();
});

it("WP13 locate can drop the pending vessel", async () => {
  setup();
  localStorage.setItem(
    "org:staff:locate",
    JSON.stringify({ id: "vessel-a", raw: "041", tag: "041", intake: "INT-0001", species: null }),
  );
  render(<LocateStation />);
  fireEvent.click(await screen.findByRole("button", { name: "Scan a different basket" }));
  await waitFor(() => expect(locateHeading()).toBe("No basket scanned"));
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

it("#84 blast Enter manually: a typed tag takes blast_vessel, flagged manual", async () => {
  const { rpc } = setup();
  render(<BlastStation />);
  await screen.findByRole("region", { name: "In blast" });
  fireEvent.click(screen.getByRole("button", { name: "Enter manually" }));
  fireEvent.change(screen.getByLabelText("Basket number"), { target: { value: "41" } });
  fireEvent.click(screen.getByRole("button", { name: "Enter" }));
  await waitFor(() =>
    expect(mocks.scan).toHaveBeenCalledWith(
      expect.objectContaining({ raw: "041", station: "blast", entry_method: "manual" }),
    ),
  );
  const call = typedRpc({ ok: false, reason: "Basket not found. Scan a different basket." });
  rpc.mockImplementationOnce(() => call as never);
  const reply = await mocks.send!({
    raw: "999",
    station: "blast",
    client_action_id: "typed-1",
    operator_session: null,
    entry_method: "manual",
  });
  expect(reply).toMatchObject({ ok: false, reason: "Basket not found. Scan a different basket." });
  expect(rpc).toHaveBeenLastCalledWith(
    "blast_vessel",
    expect.objectContaining({ p_raw: "999", p_client_action_id: "typed-1" }),
  );
  expect(call.setHeader).toHaveBeenCalledWith("x-filletry-entry-method", "manual");
});

it("#84 locate Enter manually: typed tag then typed location; a phantom location is rejected", async () => {
  const { rpc } = setup();
  render(<LocateStation />);
  fireEvent.click(await screen.findByRole("button", { name: "Enter manually" }));
  const field = screen.getByLabelText("Basket number");
  fireEvent.change(field, { target: { value: "if a 01 1 f" } });
  fireEvent.click(screen.getByRole("button", { name: "Enter" }));
  await waitFor(() =>
    expect(mocks.scan).toHaveBeenCalledWith(
      expect.objectContaining({ raw: "IF-A-01-1-F", station: "locate", entry_method: "manual" }),
    ),
  );
  const tag = typedRpc({
    ok: true,
    reason: "Basket 041",
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
  const { rpc, calls } = setup([{ ok: true, reason: "Exchange basket in blast · INT-0001" }], {
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
  await screen.findByRole("region", { name: "Waiting for blast-in" });
  expect(rows("Waiting for blast-in")).toEqual([
    "Exchange basket · INT-0001 · 10 lb · waiting 0h 30m · Blast in",
    "Basket 042 · INT-0002 · 12 lb · waiting 0h 05m · Scan",
  ]);
  expect(calls).toContainEqual(["is blast_in_at", null]);
  expect(calls).toContainEqual(["in intake.state", ["blast_freezer", "stored"]]);
  expect(screen.getByTestId("next-step").textContent).toBe("Scan a basket going into the blast");
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
  expect(reply.reason).toBe("Exchange basket in blast · INT-0001");
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
  await screen.findByRole("region", { name: "Waiting for blast-in" });
  expect(rows("Waiting for blast-in")).toEqual(["Exchange basket · INT-0001 · 10 lb · Blast in"]);
  expect(rows("In blast")).toEqual([]);
  expect(screen.getByText("Nothing in the blast yet")).toBeTruthy();
  expect(screen.queryByText("Blast freezer empty")).toBeNull();
  // Only an exchange basket waiting: the next step is the tap, not a scan (#98).
  expect(screen.getByTestId("next-step").textContent).toBe("Tap Blast in for an exchange basket");
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
        reason: "Exchange basket · INT-0001. Scan a location.",
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
      { ok: true, reason: "Exchange basket placed at IF-A-01-1-F", placed: true, reset: true },
    ],
    {
      exchange: [
        { id: "vx", weight_lb: 10, blast_in_at: minutesAgo(125), intake: { number: "INT-0001" } },
      ],
    },
  );
  render(<LocateStation />);
  await screen.findByRole("region", { name: "Exchange baskets" });
  expect(screen.getByTestId("next-step").textContent).toBe("Scan basket or tap an exchange basket");
  expect(rows("Exchange baskets")).toEqual([
    expect.stringMatching(/^Exchange basket · INT-0001 · 10 lb · in blast 2h 0[45]m · Select$/),
  ]);
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
  await waitFor(() => expect(locateHeading()).toBe("Exchange basket"));
  expect(
    within(screen.getByRole("region", { name: "Locate step" })).getByText("INT-0001"),
  ).toBeTruthy();
  expect(screen.getByTestId("next-step").textContent).toBe("Scan location for exchange basket");
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
  await waitFor(() => expect(locateHeading()).toBe("No basket scanned"));
});

it("#86 locate holds a tapped exchange basket by id with no tag text", () => {
  expect(
    nextPending(null, {
      ok: true,
      reason: "Exchange basket · INT-0001. Scan a location.",
      tag_code: null,
      intake_number: "INT-0001",
      pending_vessel_raw: null,
      pending_vessel_id: "vx",
    }),
  ).toEqual({ id: "vx", raw: "", tag: null, intake: "INT-0001", species: null });
});

it("#129 blast in shows on the tapped row at once, and a second tap sends nothing", async () => {
  setup([], {
    waiting: [
      { id: "vx", weight_lb: 10, intake: { number: "INT-0001", blast_at: null }, asset_tag: null },
      {
        id: "vt",
        weight_lb: 12,
        intake: { number: "INT-0002", blast_at: null },
        asset_tag: { code: "042" },
      },
    ],
  });
  render(<BlastStation />);
  const button = await screen.findByRole("button", { name: "Blast in exchange basket INT-0001" });
  // A tagged basket also waits, so the scan leads and Blast in is an outlined alternative.
  expect(button.className).toBe("st-btn-secondary");
  const row = button.closest(".st-basket-row")!;
  fireEvent.click(button);
  expect(mocks.scan).toHaveBeenCalledTimes(1);
  // The row's right edge turns into a spinner in the same frame (optimistic), so no second tap.
  expect(row.getAttribute("data-busy")).toBe("true");
  expect(screen.queryByRole("button", { name: "Blast in exchange basket INT-0001" })).toBeNull();
  // The reply lands and the refresh drops the spinner.
  await mocks.send!({
    raw: "",
    vessel_id: "vx",
    station: "blast",
    client_action_id: "tap-1",
    operator_session: null,
  });
  await waitFor(() => expect(row.getAttribute("data-busy")).toBeNull());
});

it("#129 blast: with only exchange baskets waiting, Blast in is the filled button", async () => {
  setup([], {
    waiting: [
      { id: "vx", weight_lb: 10, intake: { number: "INT-0001", blast_at: null }, asset_tag: null },
    ],
  });
  render(<BlastStation />);
  const button = await screen.findByRole("button", { name: "Blast in exchange basket INT-0001" });
  expect(button.className).toBe("");
  expect(screen.getByTestId("next-step").textContent).toBe("Tap Blast in for an exchange basket");
});

it("#129 locate keeps the exchange list in step 2: the chosen basket framed, another one tap", async () => {
  const exchange = [
    { id: "vx", weight_lb: 10, blast_in_at: null, intake: { number: "INT-0001" } },
    { id: "vy", weight_lb: 8, blast_in_at: null, intake: { number: "INT-0002" } },
  ];
  setup([], { exchange });
  localStorage.setItem(
    "org:staff:locate",
    JSON.stringify({ id: "vx", raw: "", tag: null, intake: "INT-0001", species: null }),
  );
  render(<LocateStation />);
  await screen.findByRole("region", { name: "Exchange baskets" });
  expect(locateHeading()).toBe("Exchange basket");
  expect(screen.getByTestId("next-step").textContent).toBe("Scan location for exchange basket");
  const chosen = screen.getByRole("button", { name: "Select exchange basket INT-0001" });
  expect(chosen.getAttribute("aria-pressed")).toBe("true");
  // Tapping the chosen basket again sends nothing; tapping the other one switches in one tap.
  fireEvent.click(chosen);
  expect(mocks.scan).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Select exchange basket INT-0002" }));
  expect(mocks.scan).toHaveBeenCalledWith(
    expect.objectContaining({ raw: "", vessel_id: "vy", station: "locate" }),
  );
});

/** One exchange basket waiting for blast-in (tapped in, not scanned). */
const blastWaiting = () => ({
  waiting: [
    { id: "vx", weight_lb: 10, intake: { number: "INT-0001", blast_at: null }, asset_tag: null },
  ],
});
const tapBlastIn = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Blast in exchange basket INT-0001" }));
  return screen
    .getByRole("region", { name: "Waiting for blast-in" })
    .querySelector(".st-basket-row")!;
};
const tapRequest = (station: "blast" | "locate", vessel_id: string): ScanRequest => ({
  raw: "",
  vessel_id,
  station,
  client_action_id: "tap-1",
  operator_session: null,
});

it("#129 blast in: a tap that was never queued clears its spinner, and can be tapped again", async () => {
  setup([], blastWaiting());
  mocks.scan.mockResolvedValueOnce(false);
  render(<BlastStation />);
  const row = await tapBlastIn();
  await waitFor(() => expect(row.getAttribute("data-busy")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Blast in exchange basket INT-0001" }));
  expect(mocks.scan).toHaveBeenCalledTimes(2);
});

it("#129 blast in: a refused tap (terminal) clears its spinner; a retryable failure keeps it", async () => {
  const { rpc } = setup([], blastWaiting());
  render(<BlastStation />);
  const row = await tapBlastIn();
  expect(row.getAttribute("data-busy")).toBe("true");
  // Network / server failure: the queue retries it, so the row stays in flight.
  rpc.mockResolvedValueOnce({ data: null, error: { status: 503 } } as never);
  await expect(mocks.send!(tapRequest("blast", "vx"))).rejects.toThrow();
  expect(row.getAttribute("data-busy")).toBe("true");
  // Refused for good (permission): the queue drops it, so the row is live again.
  rpc.mockResolvedValueOnce({ data: null, error: { code: "42501" } } as never);
  expect(await mocks.send!(tapRequest("blast", "vx"))).toMatchObject({
    ok: false,
    reason: "scan_not_permitted",
  });
  await waitFor(() => expect(row.getAttribute("data-busy")).toBeNull());
  expect(screen.getByRole("button", { name: "Blast in exchange basket INT-0001" })).toBeTruthy();
});

it("#129 locate: an exchange tap never queued, or refused for good, clears its spinner", async () => {
  const { rpc } = setup([], {
    exchange: [{ id: "vx", weight_lb: 10, blast_in_at: null, intake: { number: "INT-0001" } }],
  });
  render(<LocateStation />);
  const button = await screen.findByRole("button", { name: "Select exchange basket INT-0001" });
  mocks.scan.mockResolvedValueOnce(false);
  fireEvent.click(button);
  expect(button.getAttribute("data-busy")).toBe("true");
  await waitFor(() => expect(button.getAttribute("data-busy")).toBeNull());
  fireEvent.click(button);
  expect(button.getAttribute("data-busy")).toBe("true");
  rpc.mockResolvedValueOnce({ data: null, error: { code: "42501" } } as never);
  expect(await mocks.send!(tapRequest("locate", "vx"))).toMatchObject({
    reason: "scan_not_permitted",
  });
  await waitFor(() => expect(button.getAttribute("data-busy")).toBeNull());
  expect(locateHeading()).toBe("No basket scanned");
});
