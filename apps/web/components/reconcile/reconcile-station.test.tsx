// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ScanReply, ScanRequest } from "@/src/components/station/scan-queue";
import { ReconcileStation } from "./reconcile-station";
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
  fireEvent.click(screen.getByRole("button", { name: "Manual entry" }));
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
it("WP12 tag without an open intake is audited with Scan a tote first", async () => {
  const rpc = setup();
  localStorage.clear();
  render(<ReconcileStation />);
  await screen.findByRole("button", { name: "INT-0001" });
  rpc.mockResolvedValueOnce({
    data: { ok: false, reason: "Scan a tote first", intake_id: "", vessel_id: "" },
    error: null,
  });
  const reply = await mocks.send!({
    raw: "42",
    station: "reconcile",
    client_action_id: "wp12-no-intake",
    operator_session: null,
  });
  expect(reply.reason).toBe("Scan a tote first");
  expect(rpc).toHaveBeenCalledWith(
    "station_scan",
    expect.objectContaining({ p_reason: "Scan a tote first", p_raw: "42", p_station: "reconcile" }),
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
    data: { ok: false, reason: "Not a tag or tote", intake_id: "", vessel_id: "" },
    error: null,
  });
  const reply = await mocks.send!({
    raw: "FL:LOC:demo-plant:IF-01",
    station: "reconcile",
    client_action_id: "wp12-wrong-kind",
    operator_session: null,
  });
  expect(reply.reason).toBe("Not a tag or tote");
  expect(rpc).toHaveBeenCalledWith(
    "station_scan",
    expect.objectContaining({ p_reason: "Not a tag or tote" }),
  );
  expect(rpc).not.toHaveBeenCalledWith("reconcile_action", expect.anything());
});

it("#84 Type code: a typed tag code binds through the scan path, flagged manual", async () => {
  const rpc = setup();
  render(<ReconcileStation />);
  await screen.findByText("salmon_reds: 20 lb");
  fireEvent.click(screen.getByRole("button", { name: "Type code" }));
  fireEvent.change(screen.getByLabelText(/Type the code/), { target: { value: "42" } });
  fireEvent.click(screen.getByRole("button", { name: "Enter code" }));
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
  const audit = builder({ ok: false, reason: "Not a tag or tote" });
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
    expect.objectContaining({ p_raw: "hello", p_reason: "Not a tag or tote" }),
  );
  expect(audit.setHeader).toHaveBeenCalledWith("x-filletry-entry-method", "manual");
});

it("#84 manual weight uses a visible decimal field and is flagged on the vessel row", async () => {
  setup(12.5);
  render(<ReconcileStation />);
  fireEvent.click(await screen.findByRole("button", { name: /042/ }));
  fireEvent.click(screen.getByRole("button", { name: "Manual entry" }));
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
