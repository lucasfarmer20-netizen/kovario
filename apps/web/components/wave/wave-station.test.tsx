// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FilletryClient } from "db";
import { WaveStation } from "./wave-station";
const mocks = vi.hoisted(() => ({ session: null as unknown, scan: vi.fn(), pending: 0 }));
vi.mock("@/components/intake/use-station-session", () => ({
  useStationSession: () => ({ session: mocks.session, loaded: true }),
}));
vi.mock("@/src/components/station/use-scan-action", () => ({
  useScanAction: () => ({ scan: mocks.scan, pending: mocks.pending, feedback: null }),
}));
vi.mock("@/src/components/station/scan-feedback", () => ({ ScanFeedback: () => null }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.pending = 0;
});
function setup(scanned = 0, state = "verifying") {
  const intakes = [
    {
      id: "i1",
      number: "INT-0001",
      intake_at: "2026-10-21T00:00:00Z",
      total_incoming_lb: 100,
      tote_count: 2,
      wave_id: null,
      fast_pass: true,
      dirty_fish: true,
      ribbing: true,
      intake_line: [{ species_code: "salmon_reds" }],
    },
    {
      id: "i2",
      number: "INT-0002",
      intake_at: "2026-10-22T00:00:00Z",
      total_incoming_lb: 90,
      tote_count: 1,
      wave_id: null,
      intake_line: [],
    },
    {
      id: "i3",
      number: "INT-0003",
      intake_at: "2026-10-23T00:00:00Z",
      total_incoming_lb: 40,
      tote_count: 2,
      wave_id: "w1",
      intake_line: [],
    },
  ];
  const tables: Record<string, unknown> = {
    intake: intakes,
    wave: [{ id: "w1", number: "WAVE-0001", state }],
    wave_scan: Array.from({ length: scanned }, () => ({ wave_id: "w1" })),
    org: { settings: { wave_target_lb: 200, wave_tolerance_lb: 10 } },
  };
  const from = (name: string) => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      order: () => q,
      in: () => q,
      single: () => q,
      then: (resolve: (r: unknown) => void) =>
        Promise.resolve({ data: tables[name], error: null }).then(resolve),
    };
    return q;
  };
  const channel = { on: () => channel, subscribe: () => channel };
  const rpc = vi.fn(async () => ({ data: { ok: true, wave_id: "new-wave" }, error: null }));
  mocks.session = {
    client: {
      from,
      rpc,
      channel: () => channel,
      removeChannel: vi.fn(),
    } as unknown as FilletryClient,
    claims: { orgId: "org", userId: "staff", appRole: "staff", deviceId: null },
    siteName: "Main",
  };
  return { rpc };
}
it("WP10 holding FIFO suggestion shows age, species, flags and permits manual adjustment", async () => {
  const { rpc } = setup();
  render(<WaveStation />);
  await screen.findByText(/salmon_reds/);
  expect(screen.getByText(/FAST PASS/).textContent).toContain("DIRTY");
  expect(screen.getByText(/RIBBING/).textContent).toContain("RIBBING");
  fireEvent.click(screen.getByRole("button", { name: "Suggest FIFO fill" }));
  expect(screen.getByText("2 selected · 190 lb")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /INT-0002/ }));
  expect(screen.getByText("1 selected · 100 lb")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Create wave" }));
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "create_wave",
      expect.objectContaining({ p_intake_ids: ["i1"], p_client_action_id: expect.any(String) }),
    ),
  );
});
it("WP10 Complete stays disabled below parity", async () => {
  setup(1);
  render(<WaveStation />);
  fireEvent.click(await screen.findByRole("button", { name: /WAVE-0001/ }));
  expect(screen.getByText("1 / 2 totes")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Complete — Start Processing" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it("WP10 Complete enables at parity but blocks while scans are pending", async () => {
  const { rpc } = setup(2);
  const view = render(<WaveStation />);
  fireEvent.click(await screen.findByRole("button", { name: /WAVE-0001/ }));
  const button = screen.getByRole("button", { name: "Complete — Start Processing" });
  expect((button as HTMLButtonElement).disabled).toBe(false);
  mocks.pending = 1;
  view.rerender(<WaveStation />);
  expect((button as HTMLButtonElement).disabled).toBe(true);
  mocks.pending = 0;
  view.rerender(<WaveStation />);
  fireEvent.click(button);
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("advance_wave", expect.objectContaining({ p_wave_id: "w1" })),
  );
});
it("WP10 numbered scans persist the originating wave and action id", async () => {
  setup();
  render(<WaveStation />);
  fireEvent.click(await screen.findByRole("button", { name: /WAVE-0001/ }));
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "FL:TOTE:INT-0003:1" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(mocks.scan).toHaveBeenCalledWith(
      expect.objectContaining({
        wave_id: "w1",
        client_action_id: expect.any(String),
        raw: "FL:TOTE:INT-0003:1",
      }),
    ),
  );
});
it("WP10 draft exposes Start Verification", async () => {
  setup(0, "draft");
  render(<WaveStation />);
  fireEvent.click(await screen.findByRole("button", { name: /WAVE-0001/ }));
  expect(
    (screen.getByRole("button", { name: "Start Verification" }) as HTMLButtonElement).disabled,
  ).toBe(false);
});
