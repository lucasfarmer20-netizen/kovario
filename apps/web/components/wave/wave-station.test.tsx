// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FilletryClient } from "db";
import type { ScanRequest } from "@/src/components/station/scan-queue";
import { WaveStation } from "./wave-station";
const mocks = vi.hoisted(() => ({
  session: null as unknown,
  scan: vi.fn(),
  pending: 0,
  send: null as null | ((request: ScanRequest) => Promise<unknown>),
}));
vi.mock("@/components/intake/use-station-session", () => ({
  useStationSession: () => ({ session: mocks.session, loaded: true }),
}));
vi.mock("@/src/components/station/use-scan-action", () => ({
  useScanAction: (_scope: string, send: (request: ScanRequest) => Promise<unknown>) => {
    mocks.send = send;
    return { scan: mocks.scan, pending: mocks.pending, feedback: null };
  },
}));
vi.mock("@/src/components/station/scan-feedback", () => ({ ScanFeedback: () => null }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.pending = 0;
});
function setup(scanned = 0, state = "verifying", historicalScans = 0, activeTotes = 2) {
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
      tote_count: activeTotes,
      wave_id: "w1",
      intake_line: [],
    },
  ];
  const tables: Record<string, unknown> = {
    intake: intakes,
    wave: [{ id: "w1", number: "WAVE-0001", state }],
    wave_scan: [
      ...Array.from({ length: historicalScans }, () => ({ wave_id: "completed-wave" })),
      ...Array.from({ length: scanned }, () => ({ wave_id: "w1" })),
    ],
    org: { settings: { wave_target_lb: 200, wave_tolerance_lb: 10 } },
  };
  const from = (name: string) => {
    let countOnly = false;
    let waveId: string | undefined;
    const q: Record<string, unknown> = {
      select: (_columns: string, options?: { count?: string; head?: boolean }) => {
        countOnly = options?.count === "exact" && options.head === true;
        return q;
      },
      eq: (column: string, value: string) => {
        if (column === "wave_id") waveId = value;
        return q;
      },
      order: () => q,
      in: () => q,
      single: () => q,
      then: (resolve: (r: unknown) => void) => {
        if (name === "wave_scan") {
          const rows = (tables[name] as { wave_id: string }[]).filter(
            (row) => waveId === undefined || row.wave_id === waveId,
          );
          // PostgREST caps returned rows, but exact HEAD counts cover the full set.
          return Promise.resolve({
            data: countOnly ? null : rows.slice(0, 1000),
            count: countOnly ? rows.length : null,
            error: null,
          }).then(resolve);
        }
        return Promise.resolve({ data: tables[name], error: null }).then(resolve);
      },
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
it("WP10 current wave reaches parity after more than 1000 historical scans", async () => {
  setup(2, "verifying", 1500);
  render(<WaveStation />);
  fireEvent.click(await screen.findByRole("button", { name: /WAVE-0001/ }));
  expect(screen.getByText("2 / 2 totes")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Complete — Start Processing" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
it("WP10 exact counts preserve parity for an active wave larger than the response row limit", async () => {
  setup(1201, "verifying", 1500, 1201);
  render(<WaveStation />);
  fireEvent.click(await screen.findByRole("button", { name: /WAVE-0001/ }));
  expect(screen.getByText("1201 / 1201 totes")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Complete — Start Processing" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
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

it.each(["draft", "verifying"])(
  "WP10 Cancel wave returns %s waves to holding through an idempotent RPC",
  async (state) => {
    const { rpc } = setup(0, state);
    render(<WaveStation />);
    fireEvent.click(await screen.findByRole("button", { name: /WAVE-0001/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel wave — Return to holding" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        "cancel_wave",
        expect.objectContaining({ p_wave_id: "w1", p_client_action_id: expect.any(String) }),
      ),
    );
  },
);

it("#84 Enter manually: a typed tote short code takes the scan path, flagged manual", async () => {
  const { rpc } = setup();
  render(<WaveStation />);
  fireEvent.click(await screen.findByRole("button", { name: /WAVE-0001/ }));
  fireEvent.click(screen.getByRole("button", { name: "Enter manually" }));
  const field = screen.getByLabelText("Tote number (INT-0002-1)");
  fireEvent.change(field, { target: { value: "int-0003 1" } });
  fireEvent.click(screen.getByRole("button", { name: "Enter" }));
  await waitFor(() =>
    expect(mocks.scan).toHaveBeenCalledWith(
      expect.objectContaining({
        wave_id: "w1",
        raw: "FL:TOTE:INT-0003:1",
        station: "wave",
        entry_method: "manual",
      }),
    ),
  );
  // Delivery: the same scan_wave_tote RPC, with the entry-method header for scan_log.
  const setHeader = vi.fn();
  const reply = {
    data: { ok: false, reason: "Tote not found. Scan a tote from this wave." },
    error: null,
  };
  rpc.mockImplementationOnce(() => {
    const builder = Object.assign(Promise.resolve(reply), { setHeader });
    setHeader.mockReturnValue(builder);
    return builder as never;
  });
  await expect(
    mocks.send!({
      raw: "FL:TOTE:INT-9999:1",
      station: "wave",
      wave_id: "w1",
      client_action_id: "typed-1",
      operator_session: null,
      entry_method: "manual",
    }),
  ).resolves.toEqual(reply.data);
  expect(rpc).toHaveBeenCalledWith(
    "scan_wave_tote",
    expect.objectContaining({ p_raw: "FL:TOTE:INT-9999:1", p_client_action_id: "typed-1" }),
  );
  expect(setHeader).toHaveBeenCalledWith("x-filletry-entry-method", "manual");
  // Closing returns to the hidden scanner.
  fireEvent.click(screen.getByRole("button", { name: /Close/ }));
  expect(document.activeElement).toBe(screen.getByLabelText("Station scanner"));
});

it("#98 the next step line walks the wave: tap orders → scan each tote → complete", async () => {
  setup(1);
  render(<WaveStation />);
  await screen.findByText(/salmon_reds/);
  const next = () => screen.getByTestId("next-step").textContent;
  expect(next()).toBe("Tap orders to add to the wave");
  expect(screen.getByText("1 Add orders").getAttribute("aria-current")).toBe("step");
  expect(screen.getByText("Tap orders first")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /INT-0002/ }));
  expect(next()).toBe("Tap Create wave");
  expect(screen.queryByText("Tap orders first")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /WAVE-0001/ }));
  expect(next()).toBe("Scan each tote (1 of 2)");
  expect(screen.getByText("2 Scan totes").getAttribute("aria-current")).toBe("step");
  expect(screen.getByText("Scan every tote first (1 of 2)")).toBeTruthy();
});
it("#98 at parity the next step is Complete wave", async () => {
  setup(2);
  render(<WaveStation />);
  fireEvent.click(await screen.findByRole("button", { name: /WAVE-0001/ }));
  expect(screen.getByTestId("next-step").textContent).toBe("Complete wave");
  expect(screen.getByText("3 Complete").getAttribute("aria-current")).toBe("step");
});
