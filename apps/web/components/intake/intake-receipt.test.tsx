// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { IntakeReceipt } from "./intake-receipt";
import { useStationSession } from "./use-station-session";
import { loadIntake } from "./intake-data";
import QRCode from "qrcode";

vi.mock("./use-station-session", () => ({ useStationSession: vi.fn() }));
vi.mock("./intake-data", () => ({ loadIntake: vi.fn() }));
vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,cXI=") },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("WP20 saved intake browser receipt prints org notice, hours and canonical status QR", async () => {
  const single = vi.fn().mockResolvedValue({
    data: {
      name: "Plant A",
      slug: "plant-a",
      settings: { pickup_hours: "9–5", rates_notice: "Final charges apply" },
    },
    error: null,
  });
  const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single };
  vi.mocked(useStationSession).mockReturnValue({
    loaded: true,
    session: {
      client: { from: () => query },
      claims: { orgId: "org-a" },
    } as unknown as NonNullable<ReturnType<typeof useStationSession>["session"]>,
  });
  vi.mocked(loadIntake).mockResolvedValue({
    intake: { number: "INT-0001", intake_at: "2026-10-28T12:00:00Z", estimated_pickup_at: null },
    charges: [
      {
        id: "charge",
        description: "Processing",
        qty: 2,
        unit_price: 10,
        amount: 20,
        state: "open",
      },
    ],
  } as unknown as Awaited<ReturnType<typeof loadIntake>>);
  render(<IntakeReceipt intakeId="intake-a" />);
  await screen.findByText("Plant A · INT-0001");
  expect(QRCode.toDataURL).toHaveBeenCalledWith("https://app.filletry.com/s/plant-a", {
    width: 200,
  });
  expect(screen.getByRole("img").getAttribute("data-qr")).toBe(
    "https://app.filletry.com/s/plant-a",
  );
  expect(screen.getByText("Pickup hours: 9–5")).toBeTruthy();
  expect(screen.getByText("Final charges apply")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Print receipt" })).toBeTruthy();
});
