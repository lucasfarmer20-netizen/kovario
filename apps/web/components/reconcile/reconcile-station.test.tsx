// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ScanReply, ScanRequest } from "@/src/components/station/scan-queue";
import { ReconcileStation, reconcileNextStep } from "./reconcile-station";
const mocks = vi.hoisted(() => ({
  session: null as unknown,
  send: null as null | ((r: ScanRequest) => Promise<ScanReply>),
  pending: 0,
  vesselFilters: [] as Array<[string, unknown]>,
  scan: vi.fn(),
}));
vi.mock("@/components/intake/use-station-session", () => ({
  useStationSession: () => ({ session: mocks.session, loaded: true }),
  managerElevation: async (_client: unknown, pin: string) =>
    pin === "1234" ? { token: "elevation-token" } : { reason: "invalid_pin" },
}));
vi.mock("@/src/components/station/use-scan-action", () => ({
  useScanAction: (_: string, send: (r: ScanRequest) => Promise<ScanReply>) => {
    mocks.send = send;
    return { scan: mocks.scan, pending: mocks.pending, feedback: null };
  },
}));
vi.mock("@/src/components/station/scan-feedback", () => ({ ScanFeedback: () => null }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  mocks.pending = 0;
  mocks.vesselFilters = [];
  mocks.scan.mockReset();
});
function setup(weight = 0, extra: Record<string, unknown> = {}, appRole = "staff") {
  localStorage.setItem("org:staff:reconcile", "i1");
  const tables: Record<string, unknown> = {
    intake: [
      {
        id: "i1",
        number: "INT-0001",
        total_est_yield_lb: 20,
        intake_line: [{ species_code: "salmon_reds", est_yield_lb: 20 }],
      },
    ],
    vessel: [
      {
        id: "v1",
        intake_id: "i1",
        asset_tag_id: "t1",
        asset_tag: { code: "042" },
        weight_lb: weight,
        manual: true,
        is_exchange: false,
      },
    ],
    ...extra,
  };
  const from = (name: string) => {
    const q = {
      select: () => q,
      eq: (column: string, value: unknown) => {
        if (name === "vessel") mocks.vesselFilters.push([column, value]);
        return q;
      },
      order: () => q,
      in: () => q,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: tables[name], error: null }).then(resolve),
    };
    return q;
  };
  const channel = { on: () => channel, subscribe: () => channel };
  const rpc = vi.fn(async () => ({
    data: { ok: true, reason: "Accepted", intake_id: "i1", vessel_id: "v1" },
    error: null,
  }));
  mocks.session = {
    client: { from, rpc, channel: () => channel, removeChannel: vi.fn() },
    claims: { orgId: "org", userId: "staff", appRole },
    siteName: "Main",
  };
  return rpc;
}
it("WP12 renders expected yield, manual flag and variance; send gate blocks unweighed vessel", async () => {
  setup();
  render(<ReconcileStation />);
  expect(await screen.findByText("salmon_reds: 20 lb")).toBeTruthy();
  expect(screen.getByText(/Variance -100%/)).toBeTruthy();
  expect(screen.getByRole("button", { name: /042.*MANUAL WEIGHT/ })).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Send to Blast Freezer" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
it("WP12 selected vessel saves positive manual weight with operator proof and action id", async () => {
  const rpc = setup();
  render(<ReconcileStation />);
  fireEvent.click(await screen.findByRole("button", { name: /042/ }));
  fireEvent.click(screen.getByRole("button", { name: "Enter weight manually" }));
  fireEvent.change(screen.getByLabelText("Manual weight (lb)"), { target: { value: "12.5" } });
  fireEvent.click(screen.getByRole("button", { name: "Save manual weight" }));
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "reconcile_action",
      expect.objectContaining({
        p_operation: "manual",
        p_vessel_id: "v1",
        p_weight: 12.5,
        p_client_action_id: expect.any(String),
      }),
    ),
  );
});
it("WP12 tag padding scan adds selected vessel through atomic bind operation", async () => {
  const rpc = setup();
  render(<ReconcileStation />);
  await screen.findByRole("button", { name: /042/ });
  await mocks.send!({
    raw: "0042",
    station: "reconcile",
    client_action_id: "wp12-scan-001",
    operator_session: null,
  });
  expect(rpc).toHaveBeenCalledWith(
    "reconcile_action",
    expect.objectContaining({ p_operation: "bind", p_code: "042", p_raw: "0042" }),
  );
});
it("WP12 complete vessel enables Send to Blast; pending scans block edits", async () => {
  setup(20);
  const view = render(<ReconcileStation />);
  await screen.findByRole("button", { name: /042/ });
  expect(
    (screen.getByRole("button", { name: "Send to Blast Freezer" }) as HTMLButtonElement).disabled,
  ).toBe(false);
  mocks.pending = 1;
  view.rerender(<ReconcileStation />);
  expect(
    (screen.getByRole("button", { name: "Send to Blast Freezer" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
it("WP12 tag without an open intake is audited with Scan a tote or tap an order first", async () => {
  const rpc = setup();
  localStorage.clear();
  render(<ReconcileStation />);
  await screen.findByRole("button", { name: "INT-0001" });
  rpc.mockResolvedValueOnce({
    data: { ok: false, reason: "Scan a tote or tap an order first", intake_id: "", vessel_id: "" },
    error: null,
  });
  const reply = await mocks.send!({
    raw: "42",
    station: "reconcile",
    client_action_id: "wp12-no-intake",
    operator_session: null,
  });
  expect(reply.reason).toBe("Scan a tote or tap an order first");
  expect(rpc).toHaveBeenCalledWith(
    "station_scan",
    expect.objectContaining({
      p_reason: "Scan a tote or tap an order first",
      p_raw: "42",
      p_station: "reconcile",
    }),
  );
  expect(rpc).not.toHaveBeenCalledWith("reconcile_action", expect.anything());
});
it("WP12 vessel query is scoped to the open intake and reloads on selection", async () => {
  setup();
  localStorage.clear();
  render(<ReconcileStation />);
  const intake = await screen.findByRole("button", { name: "INT-0001" });
  expect(mocks.vesselFilters).toEqual([]);
  fireEvent.click(intake);
  await screen.findByRole("button", { name: /042/ });
  expect(mocks.vesselFilters).toContainEqual(["intake_id", "i1"]);
  expect(mocks.vesselFilters).toContainEqual(["lifecycle_state", "occupied"]);
});
it("WP12 unsupported scans produce an audited floor-friendly rejection", async () => {
  const rpc = setup();
  render(<ReconcileStation />);
  await screen.findByRole("button", { name: /042/ });
  rpc.mockResolvedValueOnce({
    data: {
      ok: false,
      reason: "Not a basket or a tote. Scan a basket or a tote.",
      intake_id: "",
      vessel_id: "",
    },
    error: null,
  });
  const reply = await mocks.send!({
    raw: "FL:LOC:demo-plant:IF-01",
    station: "reconcile",
    client_action_id: "wp12-wrong-kind",
    operator_session: null,
  });
  expect(reply.reason).toBe("Not a basket or a tote. Scan a basket or a tote.");
  expect(rpc).toHaveBeenCalledWith(
    "station_scan",
    expect.objectContaining({ p_reason: "Not a basket or a tote. Scan a basket or a tote." }),
  );
  expect(rpc).not.toHaveBeenCalledWith("reconcile_action", expect.anything());
});

it("#84 Enter manually: a typed tag code binds through the scan path, flagged manual", async () => {
  const rpc = setup();
  render(<ReconcileStation />);
  await screen.findByText("salmon_reds: 20 lb");
  fireEvent.click(screen.getByRole("button", { name: "Enter manually" }));
  fireEvent.change(screen.getByLabelText("Basket number"), { target: { value: "42" } });
  fireEvent.click(screen.getByRole("button", { name: "Enter" }));
  await waitFor(() =>
    expect(mocks.scan).toHaveBeenCalledWith(
      expect.objectContaining({ raw: "042", station: "reconcile", entry_method: "manual" }),
    ),
  );
  const builder = (data: unknown) => {
    const setHeader = vi.fn();
    const b = Object.assign(Promise.resolve({ data, error: null }), { setHeader });
    setHeader.mockReturnValue(b);
    return b;
  };
  // A phantom tag is rejected by the same bind RPC as a scan of it.
  const bind = builder({ ok: false, reason: "Unknown tag", intake_id: "i1", vessel_id: null });
  rpc.mockImplementationOnce(() => bind as never);
  const reply = await mocks.send!({
    raw: "999",
    station: "reconcile",
    client_action_id: "typed-1",
    operator_session: null,
    entry_method: "manual",
  });
  expect(reply).toMatchObject({ ok: false, reason: "Unknown tag" });
  expect(rpc).toHaveBeenLastCalledWith(
    "reconcile_action",
    expect.objectContaining({ p_operation: "bind", p_code: "999", p_raw: "999" }),
  );
  expect(bind.setHeader).toHaveBeenCalledWith("x-filletry-entry-method", "manual");
  // A malformed typed code is audited by station_scan, also flagged manual.
  const audit = builder({ ok: false, reason: "Not a basket or a tote. Scan a basket or a tote." });
  rpc.mockImplementationOnce(() => audit as never);
  await mocks.send!({
    raw: "hello",
    station: "reconcile",
    client_action_id: "typed-2",
    operator_session: null,
    entry_method: "manual",
  });
  expect(rpc).toHaveBeenLastCalledWith(
    "station_scan",
    expect.objectContaining({
      p_raw: "hello",
      p_reason: "Not a basket or a tote. Scan a basket or a tote.",
    }),
  );
  expect(audit.setHeader).toHaveBeenCalledWith("x-filletry-entry-method", "manual");
});

it("#84 manual weight uses a visible decimal field and is flagged on the vessel row", async () => {
  setup(12.5);
  render(<ReconcileStation />);
  fireEvent.click(await screen.findByRole("button", { name: /042/ }));
  fireEvent.click(screen.getByRole("button", { name: "Enter weight manually" }));
  const field = screen.getByLabelText("Manual weight (lb)");
  expect(field.getAttribute("inputmode")).toBe("decimal");
  expect(screen.getByText("MANUAL WEIGHT")).toBeTruthy();
});

// #87 variance hold ------------------------------------------------------------------------------
const member = (n: number, position: number, pct: number, band: string, state: string) => ({
  hold_id: "h1",
  flagged_intake_id: "i1",
  intake_id: n === 1 ? "i1" : `i${n}`,
  intake_number: `INT-000${n}`,
  position,
  state,
  variance_pct: pct,
  band,
  blocked: state === "reconcile",
  limit_pct: 15,
});
const held = {
  variance_hold_member: [
    member(4, -1, 2, "within", "blast_freezer"),
    member(1, 0, 40, "over", "reconcile"),
    member(2, 1, -30, "over", "reconcile"),
  ],
  org: [{ settings: { reconcile: { variance_hold_pct: 15 } } }],
};
it("#87 a flagged intake shows its hold group in rollstock order, banded, and a HELD badge", async () => {
  setup(28, held);
  render(<ReconcileStation />);
  const panel = await screen.findByRole("region", { name: "Variance hold" });
  expect(panel.textContent).toContain("VARIANCE HOLD · INT-0001 +40% (limit ±15%)");
  expect([...panel.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
    "INT-0004 · +2% · within limit · in blast",
    "INT-0001 · +40% · over limit · waiting at reconcile",
    "INT-0002 · −30% · over limit · waiting at reconcile",
  ]);
  expect(screen.getByRole("button", { name: /INT-0001.*HELD/ })).toBeTruthy();
  expect(screen.getByText(/over limit \(limit ±15%\)/).className).toContain("station-band-over");
});
it("#87 staff sign-off needs a reason and a manager PIN, then calls the single SQL function", async () => {
  const rpc = setup(28, held);
  render(<ReconcileStation />);
  await screen.findByRole("region", { name: "Variance hold" });
  const signOff = screen.getByRole("button", { name: "Manager sign-off" }) as HTMLButtonElement;
  expect(signOff.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Other" }));
  expect(screen.getByRole("alert").textContent).toBe("Other needs a note");
  fireEvent.click(screen.getByRole("button", { name: "Add note (required)" }));
  fireEvent.change(screen.getByLabelText(/Sign-off note/), { target: { value: "Bled fish" } });
  expect(signOff.disabled).toBe(true); // finish the note first
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(signOff);
  fireEvent.change(await screen.findByLabelText("Manager PIN PIN"), { target: { value: "1234" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("variance_hold_signoff", {
      p_client_action_id: expect.any(String),
      p_hold_id: "h1",
      p_reason: "other",
      p_note: "Bled fish",
      p_elevation_token: "elevation-token",
    }),
  );
});
it("#87 typing a sign-off note pauses the scanner; Done hands focus back", async () => {
  setup(28, held);
  render(<ReconcileStation />);
  const panel = await screen.findByRole("region", { name: "Variance hold" });
  const scanner = screen.getByLabelText("Station scanner") as HTMLInputElement;
  await waitFor(() => expect(document.activeElement).toBe(scanner));
  fireEvent.click(within(panel).getByRole("button", { name: "Other" }));
  fireEvent.click(within(panel).getByRole("button", { name: "Add note (required)" }));
  const note = within(panel).getByLabelText(/Sign-off note/) as HTMLInputElement;
  await waitFor(() => expect(document.activeElement).toBe(note));
  expect(scanner.disabled).toBe(true);
  // The scanner's focus capture is off while editing: a tap (pointerup) and the re-render after
  // each keystroke leave focus in the note.
  fireEvent.pointerUp(document);
  fireEvent.change(note, { target: { value: "Bled fish" } });
  await new Promise((r) => requestAnimationFrame(r));
  expect(document.activeElement).toBe(note);
  fireEvent.click(within(panel).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(document.activeElement).toBe(scanner));
  expect(scanner.disabled).toBe(false);
  expect(panel.textContent).toContain("Note: Bled fish");
  expect(within(panel).getByRole("button", { name: "Edit note (required)" })).toBeTruthy();
});
it("#87 a failed sign-off keeps the manager PIN overlay open with the reason", async () => {
  const rpc = setup(28, held);
  rpc.mockImplementation((async (name: string) =>
    name === "variance_hold_signoff"
      ? { data: null, error: { message: "manager approval required" } }
      : { data: { ok: true, reason: "Accepted" }, error: null }) as never);
  render(<ReconcileStation />);
  await screen.findByRole("region", { name: "Variance hold" });
  fireEvent.click(screen.getByRole("button", { name: "Spoilage" }));
  fireEvent.click(screen.getByRole("button", { name: "Manager sign-off" }));
  fireEvent.change(await screen.findByLabelText("Manager PIN PIN"), { target: { value: "1234" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  const overlay = screen.getByRole("dialog", { name: "Manager PIN" });
  await waitFor(() =>
    expect(within(overlay).getByRole("alert").textContent).toBe("manager approval required"),
  );
  expect(screen.getByRole("dialog", { name: "Manager PIN" })).toBeTruthy();
});
it("#87 a manager account signs off without a PIN", async () => {
  const rpc = setup(28, held, "manager");
  render(<ReconcileStation />);
  await screen.findByRole("region", { name: "Variance hold" });
  fireEvent.click(screen.getByRole("button", { name: "Trim-heavy" }));
  fireEvent.click(screen.getByRole("button", { name: "Manager sign-off" }));
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "variance_hold_signoff",
      expect.objectContaining({ p_reason: "trim_heavy", p_elevation_token: undefined }),
    ),
  );
  expect(screen.queryByLabelText("Manager PIN PIN")).toBeNull();
});
it("#87 reconcile lists the 'now in blast' lines", async () => {
  setup(20, {
    now_in_blast: [
      {
        intake_id: "i9",
        intake_number: "INT-2120",
        variance_pct: 14,
        band: "near",
        limit_pct: 15,
        rollstock_opened_at: "2026-07-20T08:00:00+00:00",
        rollstock_scan_id: "s1",
      },
    ],
  });
  render(<ReconcileStation />);
  expect(
    await screen.findByText("INT-2120 is in the blast · variance +14% · near limit"),
  ).toBeTruthy();
});
const suspect = (
  id: string,
  number: string,
  position: number,
  status: string,
  state: string,
  actual: number,
  variance: number,
) => ({
  center_intake_id: "i1",
  hold_id: "h1",
  intake_id: id,
  position,
  intake_number: number,
  state,
  status,
  waiting: false,
  expected_lb: 20,
  actual_lb: actual,
  variance_pct: variance,
  limit_pct: 15,
  band: Math.abs(variance) > 15 ? "over" : "within",
  species: ["salmon_reds"],
});
const suspectGroup = [
  suspect("i4", "INT-0004", -1, "in_blast", "blast_freezer", 20, 0),
  suspect("i1", "INT-0001", 0, "reconciled", "reconcile", 28, 40),
  suspect("i2", "INT-0002", 1, "reconciled", "reconcile", 14, -30),
];
function withSuspects(rpc: ReturnType<typeof setup>) {
  rpc.mockImplementation((async (name: string) =>
    name === "variance_suspect_group"
      ? { data: suspectGroup, error: null }
      : { data: { ok: true, reason: "Moved", intake_id: "i1" }, error: null }) as never);
  return rpc;
}
it("#88 tapping a 'now in blast' line opens the suspect picker on that intake", async () => {
  const rpc = withSuspects(
    setup(20, {
      now_in_blast: [
        {
          intake_id: "i4",
          intake_number: "INT-0004",
          variance_pct: 0,
          band: "within",
          limit_pct: 15,
          rollstock_opened_at: "2026-07-20T08:00:00+00:00",
          rollstock_scan_id: "s1",
        },
      ],
    }),
  );
  render(<ReconcileStation />);
  fireEvent.click(
    await screen.findByRole("button", { name: /INT-0004 is in the blast · variance 0%/ }),
  );
  const picker = await screen.findByRole("region", { name: "Suspect picker" });
  expect(rpc).toHaveBeenCalledWith("variance_suspect_group", { p_intake_id: "i4" });
  expect(picker.textContent).toContain("SUSPECTS · INT-0001 +40% (limit ±15%) · HELD");
  fireEvent.click(within(picker).getByRole("button", { name: "Close suspects" }));
  expect(screen.queryByRole("region", { name: "Suspect picker" })).toBeNull();
});
it("#88 a staff bin move from the hold's picker needs a manager PIN, then calls the single SQL function", async () => {
  const rpc = withSuspects(setup(28, held));
  render(<ReconcileStation />);
  const panel = await screen.findByRole("region", { name: "Variance hold" });
  fireEvent.click(within(panel).getByRole("button", { name: "Find the fish (suspects)" }));
  const picker = await screen.findByRole("region", { name: "Suspect picker" });
  expect(rpc).toHaveBeenCalledWith("variance_suspect_group", { p_intake_id: "i1" });
  fireEvent.click(await within(picker).findByRole("button", { name: "Basket 042 · 28 lb" }));
  fireEvent.click(
    within(picker).getByRole("button", { name: "Move basket 042 · 28 lb to INT-0002" }),
  );
  fireEvent.change(await screen.findByLabelText("Manager PIN PIN"), { target: { value: "1234" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("variance_move_vessel", {
      p_client_action_id: expect.any(String),
      p_vessel_id: "v1",
      p_to_intake_id: "i2",
      p_center_intake_id: "i1",
      p_elevation_token: "elevation-token",
    }),
  );
});
it("#88 typing a pull-back reason pauses the scanner; a manager account pulls back without a PIN", async () => {
  const rpc = withSuspects(setup(28, held, "manager"));
  render(<ReconcileStation />);
  const panel = await screen.findByRole("region", { name: "Variance hold" });
  fireEvent.click(within(panel).getByRole("button", { name: "Find the fish (suspects)" }));
  const picker = await screen.findByRole("region", { name: "Suspect picker" });
  const scanner = screen.getByLabelText("Station scanner") as HTMLInputElement;
  fireEvent.click(await within(picker).findByRole("button", { name: "Pull back INT-0004" }));
  fireEvent.click(within(picker).getByRole("button", { name: "Add reason" }));
  const reason = within(picker).getByLabelText(/Pull back reason/) as HTMLInputElement;
  await waitFor(() => expect(document.activeElement).toBe(reason));
  expect(scanner.disabled).toBe(true);
  fireEvent.change(reason, { target: { value: "Fish from INT-0001" } });
  fireEvent.click(within(picker).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(scanner.disabled).toBe(false));
  fireEvent.click(within(picker).getByRole("button", { name: "Confirm pull back" }));
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("intake_pull_back", {
      p_client_action_id: expect.any(String),
      p_intake_id: "i4",
      p_reason: "Fish from INT-0001",
      p_elevation_token: undefined,
    }),
  );
  expect(screen.queryByLabelText("Manager PIN PIN")).toBeNull();
});

const next = () => screen.getByTestId("next-step").textContent;
it("#98 next step: no order open → Scan a tote or tap an order", async () => {
  setup();
  localStorage.setItem("org:staff:reconcile", "");
  render(<ReconcileStation />);
  await screen.findByRole("heading", { name: "No order open" });
  expect(next()).toBe("Scan a tote or tap an order");
  expect(screen.getByText("1 Add baskets").getAttribute("aria-current")).toBe("step");
});
it("#98 next step: an open order with no baskets → Scan basket; Send says why it is disabled", async () => {
  setup(0, { vessel: [] });
  render(<ReconcileStation />);
  await screen.findByRole("heading", { name: "Order INT-0001" });
  expect(next()).toBe("Scan basket");
  expect(screen.getAllByText("Add a basket first").length).toBeGreaterThan(0);
});
it("#98 next step: an unweighed basket asks for the tap, then Weigh basket 042", async () => {
  setup();
  render(<ReconcileStation />);
  await screen.findByRole("button", { name: /Basket 042/ });
  expect(next()).toBe("Tap basket 042, then weigh it");
  expect(screen.getByText("2 Weigh").getAttribute("aria-current")).toBe("step");
  expect(screen.getAllByText("Tap a basket first").length).toBeGreaterThan(0);
  expect(screen.getByText("Weigh every basket first")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Basket 042/ }));
  expect(next()).toBe("Weigh basket 042");
});
it("#98 with several unweighed baskets the prompt never names a basket the weight buttons won't write", async () => {
  const vessel = [
    { id: "v1", intake_id: "i1", asset_tag_id: "t1", asset_tag: { code: "042" }, weight_lb: 0 },
    { id: "v2", intake_id: "i1", asset_tag_id: "t2", asset_tag: { code: "043" }, weight_lb: 0 },
  ].map((v) => ({ ...v, manual: false, is_exchange: false }));
  const rpc = setup(0, { vessel });
  rpc.mockImplementation((async (
    _name: string,
    args: { p_vessel_id?: string; p_weight?: number },
  ) => {
    const row = vessel.find((v) => v.id === args.p_vessel_id);
    if (row && args.p_weight) row.weight_lb = args.p_weight;
    return {
      data: { ok: true, reason: "Weighed", intake_id: "i1", vessel_id: row?.id },
      error: null,
    };
  }) as never);
  render(<ReconcileStation />);
  fireEvent.click(await screen.findByRole("button", { name: /Basket 042/ }));
  expect(next()).toBe("Weigh basket 042");
  const weigh = async (lb: string) => {
    fireEvent.click(screen.getByRole("button", { name: "Enter weight manually" }));
    fireEvent.change(screen.getByLabelText("Manual weight (lb)"), { target: { value: lb } });
    fireEvent.click(screen.getByRole("button", { name: "Save manual weight" }));
  };
  await weigh("9");
  // 042 is weighed and still selected: the line asks for the tap on 043, not "Weigh basket 043".
  await waitFor(() => expect(next()).toBe("Tap basket 043, then weigh it"));
  expect(
    screen.getByRole("button", { name: /Basket 042 · 9 lb/ }).getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: /Basket 043/ }));
  expect(next()).toBe("Weigh basket 043");
  await weigh("11");
  await waitFor(() => expect(next()).toBe("Send to Blast"));
  const calls = rpc.mock.calls as unknown as Array<
    [string, { p_operation?: string; p_vessel_id?: string }]
  >;
  const weighed = calls.filter(([, a]) => a.p_operation === "manual").map(([, a]) => a.p_vessel_id);
  expect(weighed).toEqual(["v1", "v2"]);
});
it("#98 next step: every basket weighed within the limit → Send to Blast", async () => {
  setup(20);
  render(<ReconcileStation />);
  await screen.findByRole("button", { name: /Basket 042 · 20 lb/ });
  expect(next()).toBe("Send to Blast");
  expect(screen.getByText("3 Send to Blast").getAttribute("aria-current")).toBe("step");
  expect(screen.queryByText("Weigh every basket first")).toBeNull();
});
it("#98 next step over the limit asks to check weights, with a true minus sign", () => {
  const rows = [{ id: "v1", weight_lb: 16.4, is_exchange: false, asset_tag: { code: "005" } }];
  expect(
    reconcileNextStep({ open: true, rows, selected: null, variance: -18, over: true, held: false })
      .next,
  ).toBe("Over the limit (−18%). Check weights before sending.");
  expect(
    reconcileNextStep({
      open: true,
      rows: [...rows, { id: "v2", weight_lb: 0, is_exchange: true, asset_tag: null }],
      selected: null,
      variance: -18,
      over: true,
      held: false,
    }).next,
  ).toBe("Tap exchange basket, then weigh it");
});

// #97 empty state ---------------------------------------------------------------------------------
const orderCard = async () =>
  (await screen.findByRole("heading", { name: "Order INT-0001" })).closest("section")!;
const isDisabled = (name: string) =>
  (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;
/** A PostgREST builder: typed codes set the entry-method header on it before it is awaited. */
const rpcBuilder = (data: unknown) => {
  const b = Object.assign(Promise.resolve({ data, error: null }), { setHeader: () => b });
  return b;
};
it("#97 an empty order shows the first step and no verdict: no variance, band or warning", async () => {
  setup(0, { vessel: [] });
  render(<ReconcileStation />);
  const card = await orderCard();
  expect(next()).toBe("Scan basket");
  expect(within(card).getByText("Scan basket to add it — or tap Enter manually.")).toBeTruthy();
  expect(within(card).getByText("Expected 20.00 lb · No baskets yet")).toBeTruthy();
  expect(screen.queryByText(/Variance/)).toBeNull();
  expect(card.querySelector(".station-band")).toBeNull();
  expect(screen.queryByText(/over limit|will be refused/)).toBeNull();
  // Enter manually sits in the order card, next to Add exchange basket, and only there.
  expect(screen.getAllByRole("button", { name: "Enter manually" })).toHaveLength(1);
  const row = within(card)
    .getByRole("button", { name: "Enter manually" })
    .closest<HTMLElement>(".station-add-basket")!;
  expect(within(row).getByRole("button", { name: "Add exchange basket" })).toBeTruthy();
  // The weight buttons say why they are disabled.
  for (const name of ["Accept scale weight", "Enter weight manually", "Remove selected basket"])
    expect(isDisabled(name)).toBe(true);
  expect(screen.getAllByText("Add a basket first")).toHaveLength(4);
  expect(screen.queryByText("Tap a basket first")).toBeNull();
});
it("#97 a typed basket number adds the basket and selects it; Enter weight manually is live", async () => {
  const vessel: unknown[] = [];
  const rpc = setup(0, { vessel });
  rpc.mockImplementation(((name: string, args: { p_operation?: string; p_code?: string }) => {
    if (name === "reconcile_action" && args.p_operation === "bind")
      vessel.push({
        id: "v7",
        intake_id: "i1",
        asset_tag_id: "t7",
        asset_tag: { code: args.p_code },
        weight_lb: 0,
        manual: false,
        is_exchange: false,
      });
    return rpcBuilder({
      ok: true,
      reason: "Basket 042 added to INT-0001",
      intake_id: "i1",
      vessel_id: "v7",
    });
  }) as never);
  mocks.scan.mockImplementationOnce((r: ScanRequest) => mocks.send!(r));
  render(<ReconcileStation />);
  const card = await orderCard();
  const scanner = screen.getByLabelText("Station scanner") as HTMLInputElement;
  fireEvent.click(within(card).getByRole("button", { name: "Enter manually" }));
  expect(scanner.disabled).toBe(true);
  fireEvent.change(within(card).getByLabelText("Basket number"), { target: { value: "42" } });
  fireEvent.click(within(card).getByRole("button", { name: "Enter" }));
  const basket = await within(card).findByRole("button", { name: /Basket 042/ });
  await waitFor(() => expect(basket.getAttribute("aria-pressed")).toBe("true"));
  expect(rpc).toHaveBeenCalledWith(
    "reconcile_action",
    expect.objectContaining({ p_operation: "bind", p_code: "042", p_raw: "042" }),
  );
  expect(next()).toBe("Weigh basket 042");
  expect(isDisabled("Enter weight manually")).toBe(false);
  expect(screen.queryByText("Tap a basket first")).toBeNull();
  // No focus trap: closing the field hands focus back to the scanner.
  fireEvent.click(within(card).getByRole("button", { name: "Close — back to scanner" }));
  await waitFor(() => expect(document.activeElement).toBe(scanner));
  expect(scanner.disabled).toBe(false);
});
it("#97 a scanned basket is selected too, ready to weigh", async () => {
  setup();
  render(<ReconcileStation />);
  const basket = await screen.findByRole("button", { name: /Basket 042/ });
  expect(basket.getAttribute("aria-pressed")).toBe("false");
  await mocks.send!({
    raw: "0042",
    station: "reconcile",
    client_action_id: "scan-select",
    operator_session: null,
  });
  await waitFor(() => expect(basket.getAttribute("aria-pressed")).toBe("true"));
  expect(next()).toBe("Weigh basket 042");
  expect(isDisabled("Enter weight manually")).toBe(false);
});
it("#97 with no order open, Enter manually under the next step line reads a tote number", async () => {
  setup();
  localStorage.setItem("org:staff:reconcile", "");
  render(<ReconcileStation />);
  await screen.findByRole("heading", { name: "No order open" });
  fireEvent.click(screen.getByRole("button", { name: "Enter manually" }));
  expect(screen.getByLabelText("Tote number (INT-0002-1)")).toBeTruthy();
});
