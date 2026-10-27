// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ScanReply, ScanRequest } from "@/src/components/station/scan-queue";
import { ReconcileStation } from "./reconcile-station";
const mocks = vi.hoisted(() => ({
  session: null as unknown,
  send: null as null | ((r: ScanRequest) => Promise<ScanReply>),
  pending: 0,
  vesselFilters: [] as Array<[string, unknown]>,
}));
vi.mock("@/components/intake/use-station-session", () => ({
  useStationSession: () => ({ session: mocks.session, loaded: true }),
}));
vi.mock("@/src/components/station/use-scan-action", () => ({
  useScanAction: (_: string, send: (r: ScanRequest) => Promise<ScanReply>) => {
    mocks.send = send;
    return { scan: vi.fn(), pending: mocks.pending, feedback: null };
  },
}));
vi.mock("@/src/components/station/scan-feedback", () => ({ ScanFeedback: () => null }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  mocks.pending = 0;
  mocks.vesselFilters = [];
});
function setup(weight = 0) {
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
    claims: { orgId: "org", userId: "staff", appRole: "staff" },
    siteName: "Main",
  };
  return rpc;
}
it("WP12 renders expected yield, manual flag and variance; send gate blocks unweighed vessel", async () => {
  setup();
  render(<ReconcileStation />);
  expect(await screen.findByText("salmon_reds: 20 lb")).toBeTruthy();
  expect(screen.getByText(/Variance -100%/)).toBeTruthy();
  expect(screen.getByRole("button", { name: /042.*manual/ })).toBeTruthy();
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
