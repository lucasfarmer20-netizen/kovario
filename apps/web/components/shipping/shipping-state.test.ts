import { describe, expect, it } from "vitest";
import { filterShipments, statusLine, type Shipment } from "./shipping-state";

const base: Shipment = {
  shipment_id: "s1",
  number: "SHP-0001",
  state: "draft",
  is_walkin: false,
  customer_name: "Pat Party",
  angler_name: "Ann",
  session_number: "ALC-0001",
  ship_to: { name: "Ann Angler", street1: "1 Main", city: "Kenai", state: "AK", zip: "99611" },
  ship_from: null,
  ship_date: "2026-07-21",
  carrier: "ups",
  service: "2nd Day Air",
  rate_amount: 121.75,
  shippo_rate_id: "rate_1",
  rate_shop: null,
  address_check: null,
  tracking_number: null,
  tracking_status: null,
  notes: "",
  blockers: [],
  buying: false,
  buy_error: null,
  purchase_outstanding: false,
  rate_lock: null,
  gate: { held: false, blockers: [], can_buy: true, can_reprint: false },
  today: "2026-07-20",
  parcels: [
    {
      parcel_id: "p1",
      seq: 0,
      kind: "box",
      box_number: "BOX-0007",
      box_state: "packed",
      box_size: "Medium",
      weight_lb: 40,
      dims: {},
      tracking_number: null,
      tracking_status: null,
      has_label: false,
      label_printed_at: null,
    },
  ],
};

const sh = (over: Partial<Shipment>): Shipment => ({ ...base, ...over });
const held = sh({
  number: "SHP-0002",
  state: "held",
  ship_date: "2026-07-24",
  gate: { held: true, blockers: [], can_buy: false, can_reprint: false },
});
const heldBlocked = sh({
  number: "SHP-0003",
  state: "held",
  ship_date: "2026-07-24",
  gate: { held: true, blockers: ["bad_address", "no_service"], can_buy: false, can_reprint: false },
});
const bought = sh({
  number: "SHP-0004",
  state: "label_bought",
  tracking_number: "1Z999",
  gate: { held: false, blockers: [], can_buy: false, can_reprint: true },
});
const walkin = sh({ number: "SHP-0005", is_walkin: true, parcels: [] });
const shipped = sh({ number: "SHP-0006", state: "shipped", tracking_status: "IN_TRANSIT" });
const all = [base, held, heldBlocked, bought, walkin, shipped];
const numbers = (rows: Shipment[]) => rows.map((r) => r.number);

describe("queue filters", () => {
  it("views: open, ready, held, blocked, bought, shipped", () => {
    const f = (view: Parameters<typeof filterShipments>[1]["view"]) =>
      numbers(filterShipments(all, { view, kind: "all", q: "" }));
    expect(f("open")).toEqual(["SHP-0001", "SHP-0002", "SHP-0003", "SHP-0004", "SHP-0005"]);
    expect(f("ready")).toEqual(["SHP-0001", "SHP-0005"]);
    expect(f("held")).toEqual(["SHP-0002", "SHP-0003"]);
    expect(f("blocked")).toEqual(["SHP-0003"]);
    expect(f("bought")).toEqual(["SHP-0004"]);
    expect(f("shipped")).toEqual(["SHP-0006"]);
  });

  it("walk-in filter", () => {
    expect(numbers(filterShipments(all, { view: "all", kind: "walkin", q: "" }))).toEqual([
      "SHP-0005",
    ]);
    expect(numbers(filterShipments(all, { view: "all", kind: "boxes", q: "" }))).not.toContain(
      "SHP-0005",
    );
  });

  it("search by number, customer, box, tracking", () => {
    const q = (text: string) =>
      numbers(filterShipments(all, { view: "all", kind: "all", q: text }));
    expect(q("shp-0004")).toEqual(["SHP-0004"]);
    expect(q("1z999")).toEqual(["SHP-0004"]);
    expect(q("box-0007")).toHaveLength(5); // every fixture but the walk-in carries BOX-0007
    expect(q("pat")).toHaveLength(6);
  });
});

describe("status line", () => {
  it("I13b — held and its real blockers are shown together", () => {
    expect(statusLine(heldBlocked)).toBe(
      "Held — ships 2026-07-24, buy opens nearer the date · blocked: carrier rejected the address, no rate chosen",
    );
  });

  it("P10 — held alone is information", () => {
    expect(statusLine(held)).toBe("Held — ships 2026-07-24, buy opens nearer the date");
  });

  it("blocked, ready, bought, shipped", () => {
    expect(
      statusLine(
        sh({
          gate: {
            held: false,
            blockers: ["missing_ship_date"],
            can_buy: false,
            can_reprint: false,
          },
        }),
      ),
    ).toBe("Blocked: no ship date");
    expect(statusLine(base)).toBe("Ready to buy");
    expect(statusLine(bought)).toMatch(/^Label bought/);
    expect(statusLine(shipped)).toBe("Shipped · in transit");
  });
});
