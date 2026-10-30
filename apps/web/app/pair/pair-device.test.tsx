// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PairDevice } from "./pair-device";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/lib/supabase/device", () => ({ getDeviceClient: vi.fn() }));
afterEach(cleanup);

it("#98 pairing shows its next step and names the expected code; a bad code says what to do", () => {
  render(<PairDevice initialCode="" />);
  expect(screen.getByTestId("next-step").textContent).toBe("Scan the pairing QR or enter the code");
  const field = screen.getByLabelText("Pairing code (8 characters)");
  fireEvent.change(field, { target: { value: "nope" } });
  fireEvent.submit(field.closest("form")!);
  expect(screen.getByRole("alert").textContent).toBe(
    "That is not a pairing code. Scan the pairing QR or enter its 8 characters.",
  );
});
