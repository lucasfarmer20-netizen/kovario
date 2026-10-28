// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StatusForm } from "./status-form";
import { lookupStatus } from "./actions";
vi.mock("./actions", () => ({ lookupStatus: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("WP20 phone lookup renders plain stage, amount due, hours and notice without weights", async () => {
  vi.mocked(lookupStatus).mockResolvedValue({
    org_name: "Plant A",
    timezone: "UTC",
    pickup_hours: "9–5",
    rates_notice: "Rates agreed at intake apply.",
    intakes: [{ number: "INT-0001", state: "stored", estimated_pickup_at: null, amount_due: 42.5 }],
  });
  render(<StatusForm orgSlug="plant-a" />);
  fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "9075551234" } });
  fireEvent.submit(screen.getByRole("button", { name: "Check status" }).closest("form")!);
  await screen.findByText("INT-0001 · Ready for pickup");
  expect(lookupStatus).toHaveBeenCalledWith("plant-a", "9075551234");
  expect(screen.getByText("Amount due: $42.50")).toBeTruthy();
  expect(screen.getByText("Pickup hours: 9–5")).toBeTruthy();
  expect(screen.getByText("Rates agreed at intake apply.")).toBeTruthy();
});
it("WP20 public form displays rate limit feedback and permits retry", async () => {
  vi.mocked(lookupStatus).mockResolvedValue({
    error: "Too many lookups. Please wait a minute and try again.",
  });
  render(<StatusForm orgSlug="plant-a" />);
  fireEvent.submit(screen.getByRole("button").closest("form")!);
  await screen.findByRole("alert");
  await waitFor(() => expect(screen.getByRole("button").hasAttribute("disabled")).toBe(false));
});
