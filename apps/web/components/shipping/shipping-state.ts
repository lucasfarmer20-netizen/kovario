// Pure helpers for the /shipping queue (docs/06-STATIONS-UX.md "Shipping"): the shapes
// shipping_queue / shipment_detail return, the queue filters, and the one status line the desk
// reads. The buy gate itself is SQL (app.shipment_gate — WP-15's I13 / I13b / I14 rule); the
// screen only displays it, so held and every blocker are always shown together.
import type { Address } from "shipping";

export type Gate = { held: boolean; blockers: string[]; can_buy: boolean; can_reprint: boolean };

export type ShipmentState = "draft" | "held" | "label_bought" | "shipped" | "cancelled";

export type ShopRate = {
  rateId: string;
  carrier: string;
  provider: string;
  service: string;
  amount: number;
  currency: string;
  estimatedDays: number | null;
};

export type ShipmentParcelRow = {
  parcel_id: string;
  seq: number;
  kind: "box" | "walkin";
  box_number: string | null;
  box_state: string | null;
  box_size: string | null;
  weight_lb: number;
  dims: Record<string, number | null>;
  tracking_number: string | null;
  tracking_status: string | null;
  has_label: boolean;
  label_printed_at: string | null;
};

export type Shipment = {
  shipment_id: string;
  number: string;
  state: ShipmentState;
  is_walkin: boolean;
  customer_name: string | null;
  angler_name: string | null;
  session_number: string | null;
  ship_to: Partial<Address>;
  ship_from: Partial<Address> | null;
  ship_date: string | null;
  carrier: string | null;
  service: string | null;
  rate_amount: number | null;
  shippo_rate_id: string | null;
  rate_shop: {
    rates: ShopRate[];
    missingCarriers: string[];
    carrierMessages: { carrier: string; text: string }[];
    attempts: number;
    at: string;
  } | null;
  address_check: { valid: boolean; messages: string[]; at: string } | null;
  tracking_number: string | null;
  tracking_status: string | null;
  notes: string;
  blockers: string[];
  buying: boolean;
  buy_error: string | null;
  /** A purchase reached Shippo and is not recorded: the rate is pinned until Buy fetches it. */
  purchase_outstanding: boolean;
  /** Why the rate cannot change now (live purchase / outstanding purchase), else null. */
  rate_lock: string | null;
  gate: Gate;
  today: string;
  parcels: ShipmentParcelRow[];
};

export type UnassignedGroup = {
  settlement_id: string;
  settlement_number: string;
  angler_name: string;
  customer_id: string | null;
  customer_name: string | null;
  session_number: string;
  boxes: {
    box_plan_id: string;
    number: string;
    state: string;
    weight_lb: number;
    box_size: string | null;
  }[];
};

export type Queue = { today: string; shipments: Shipment[]; unassigned: UnassignedGroup[] };

export const BLOCKER_LABELS: Record<string, string> = {
  address_unverified: "address not verified",
  bad_address: "carrier rejected the address",
  missing_ship_date: "no ship date",
  no_service: "no rate chosen",
};

export const blockerLabel = (code: string) => BLOCKER_LABELS[code] ?? code.replaceAll("_", " ");

export type QueueView =
  "open" | "ready" | "held" | "blocked" | "bought" | "shipped" | "cancelled" | "all";
export type KindFilter = "all" | "boxes" | "walkin";
export type QueueFilters = { view: QueueView; kind: KindFilter; q: string };

export const VIEW_LABELS: Record<QueueView, string> = {
  open: "Open (not shipped)",
  ready: "Ready to buy",
  held: "Held (ships later)",
  blocked: "Blocked",
  bought: "Label bought",
  shipped: "Shipped",
  cancelled: "Cancelled",
  all: "All",
};

const unbought = (s: Shipment) => s.state === "draft" || s.state === "held";

export function matchesView(s: Shipment, view: QueueView): boolean {
  switch (view) {
    case "open":
      return unbought(s) || s.state === "label_bought";
    case "ready":
      return unbought(s) && s.gate.can_buy;
    case "held":
      return unbought(s) && s.gate.held;
    case "blocked":
      return unbought(s) && s.gate.blockers.length > 0;
    case "bought":
      return s.state === "label_bought";
    case "shipped":
      return s.state === "shipped";
    case "cancelled":
      return s.state === "cancelled";
    case "all":
      return true;
  }
}

export function filterShipments(rows: readonly Shipment[], f: QueueFilters): Shipment[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter(
    (s) =>
      matchesView(s, f.view) &&
      (f.kind === "all" || (f.kind === "walkin") === s.is_walkin) &&
      (!q ||
        [
          s.number,
          s.customer_name,
          s.angler_name,
          s.session_number,
          s.ship_to.name,
          s.tracking_number,
          ...s.parcels.map((p) => p.box_number),
          ...s.parcels.map((p) => p.tracking_number),
        ].some((v) => v?.toLowerCase().includes(q))),
  );
}

/**
 * The one line the desk reads. Held is information, not an error, and it never hides a real
 * blocker (I13b): "Held — ships 2026-07-24 · blocked: no rate chosen".
 */
export function statusLine(s: Shipment): string {
  if (s.state === "cancelled") return "Cancelled";
  if (s.state === "shipped")
    return `Shipped${s.tracking_status ? ` · ${s.tracking_status.toLowerCase().replaceAll("_", " ")}` : ""}`;
  if (s.state === "label_bought") return "Label bought — print and hand to the carrier";
  if (s.buying) return "Buying label…";
  if (s.purchase_outstanding) return "Label purchase not recorded — press Buy to fetch the labels";
  const parts: string[] = [];
  if (s.gate.held) parts.push(`Held — ships ${s.ship_date}, buy opens nearer the date`);
  if (s.gate.blockers.length)
    parts.push(`blocked: ${s.gate.blockers.map(blockerLabel).join(", ")}`);
  if (!parts.length) return "Ready to buy";
  const line = parts.join(" · ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

export function money(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `$${Number(n).toFixed(2)}`;
}
