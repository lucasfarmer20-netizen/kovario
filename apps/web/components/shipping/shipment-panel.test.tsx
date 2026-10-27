// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ShipmentPanel, type ShipmentActions } from "./shipment-panel";
import type { Shipment } from "./shipping-state";

afterEach(cleanup);

const held: Shipment = {
  shipment_id: "s1",
  number: "SHP-0003",
  state: "held",
  is_walkin: false,
  customer_name: "Pat Party",
  angler_name: "Bo",
  session_number: "ALC-0001",
  ship_to: {
    name: "Bo",
    street1: "1 Main",
    city: "Kenai",
    state: "AK",
    zip: "99611",
    country: "US",
  },
  ship_from: null,
  ship_date: "2026-07-25",
  carrier: null,
  service: null,
  rate_amount: null,
  shippo_rate_id: null,
  rate_shop: {
    rates: [
      {
        rateId: "rate_ups_2da",
        carrier: "ups",
        provider: "UPS",
        service: "2nd Day Air",
        amount: 121.75,
        currency: "USD",
        estimatedDays: 2,
      },
    ],
    missingCarriers: ["fedex"],
    carrierMessages: [],
    attempts: 4,
    at: "2026-07-20T10:00:00Z",
  },
  address_check: {
    valid: false,
    messages: ["The address as submitted could not be found."],
    at: "x",
  },
  tracking_number: null,
  tracking_status: null,
  notes: "",
  blockers: ["bad_address"],
  buying: false,
  buy_error: null,
  gate: { held: true, blockers: ["bad_address", "no_service"], can_buy: false, can_reprint: false },
  today: "2026-07-20",
  parcels: [
    {
      parcel_id: "p1",
      seq: 0,
      kind: "box",
      box_number: "BOX-0004",
      box_state: "packed",
      box_size: "Medium",
      weight_lb: 30,
      dims: {},
      tracking_number: null,
      tracking_status: null,
      has_label: false,
      label_printed_at: null,
    },
  ],
};

function actions(over: Partial<ShipmentActions> = {}): ShipmentActions {
  const fail = () => Promise.reject(new Error("not expected"));
  return {
    update: fail,
    verify: fail,
    shop: fail,
    select: fail,
    buy: fail,
    print: fail,
    markShipped: fail,
    cancel: fail,
    elevate: fail,
    ...over,
  };
}

it("I13b — a held shipment shows its real blockers alongside the held notice; Buy is off, Buy Now offered", () => {
  render(<ShipmentPanel shipment={held} actions={actions()} onChanged={() => {}} />);
  expect(screen.getByRole("status").textContent).toContain(
    "Held — ships 2026-07-25, buy opens nearer the date · blocked: carrier rejected the address, no rate chosen",
  );
  expect(screen.getByRole("list", { name: "Blockers" }).textContent).toContain(
    "carrier rejected the address",
  );
  expect(screen.getByRole("list", { name: "Address problems" }).textContent).toContain(
    "could not be found",
  );
  expect((screen.getByRole("button", { name: "Buy label" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(
    (screen.getByRole("button", { name: "Buy Now (manager)" }) as HTMLButtonElement).disabled,
  ).toBe(false);
  // A thin rate shop names the silent carriers.
  expect(screen.getByText(/No answer from fedex after 4 tries/)).toBeTruthy();
});

it("I14 — Buy Now asks for a manager PIN and buys with the elevation token", async () => {
  const buy = vi.fn(async (token: string | null) => ({
    shipment: {
      ...held,
      state: "label_bought" as const,
      gate: { ...held.gate, can_reprint: true },
    },
    notice: token ? "Labels bought." : "",
  }));
  const elevate = vi.fn(async () => ({ token: "elev-1" }));
  render(
    <ShipmentPanel shipment={held} actions={actions({ buy, elevate })} onChanged={() => {}} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Buy Now (manager)" }));
  fireEvent.change(screen.getByLabelText("Manager PIN PIN"), { target: { value: "1234" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(buy).toHaveBeenCalledWith("elev-1"));
  expect(elevate).toHaveBeenCalledWith("1234");
  await screen.findByRole("button", { name: "Print labels" });
});

it("P24 — a bought label on a future-dated shipment can always be reprinted", async () => {
  const bought: Shipment = {
    ...held,
    state: "label_bought",
    carrier: "ups",
    service: "2nd Day Air",
    rate_amount: 121.75,
    gate: { held: false, blockers: [], can_buy: false, can_reprint: true },
    parcels: [{ ...held.parcels[0]!, has_label: true, label_printed_at: "2026-07-20T11:00:00Z" }],
  };
  const print = vi.fn(async () => "1 label sent to the printer.");
  render(<ShipmentPanel shipment={bought} actions={actions({ print })} onChanged={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Reprint labels" }));
  await screen.findByText("1 label sent to the printer.");
  expect((screen.getByRole("button", { name: "Mark shipped" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});

it("a bought label needs a manager to cancel", () => {
  const bought: Shipment = {
    ...held,
    state: "label_bought",
    gate: { ...held.gate, can_reprint: true },
  };
  const cancel = vi.fn();
  render(<ShipmentPanel shipment={bought} actions={actions({ cancel })} onChanged={() => {}} />);
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "customer moved" } });
  fireEvent.click(screen.getByRole("button", { name: /Cancel SHP-0003/ }));
  expect(screen.getByRole("dialog", { name: "Manager PIN" })).toBeTruthy();
  expect(cancel).not.toHaveBeenCalled();
});
