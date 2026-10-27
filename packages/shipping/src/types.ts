// Filletry-side shapes for shipping (docs/07-INTEGRATIONS.md §4). Shippo's own JSON shapes
// stay inside shippo.ts; everything else speaks these.

/** A postal address as stored in `shipment.ship_to` / `site.ship_from` (Shippo field names). */
export type Address = {
  name: string;
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
  email?: string;
};

/** One physical box handed to the carrier. Inches and lb (DECISION-11). */
export type Parcel = {
  length_in: number;
  width_in: number;
  height_in: number;
  /** Gross: fish + packaging + dry ice. */
  weight_lb: number;
  dry_ice_lb: number;
};

export type AddressCheck = {
  valid: boolean;
  /** The carrier-normalised address when valid (street casing, ZIP+4, …). */
  normalized: Address | null;
  messages: string[];
};

export type Rate = {
  /** Shippo rate object id — what a label is bought with. */
  rateId: string;
  /** Allowlist token: `usps`, `ups`, `fedex`, `dhl_express`, … */
  carrier: string;
  /** Display name as the carrier reports it ("FedEx"). */
  provider: string;
  service: string;
  serviceToken: string;
  amount: number;
  currency: string;
  estimatedDays: number | null;
};

export type RateShop = {
  shippoShipmentId: string;
  /** Rates the org may buy (allowlist applied unless bypassed), cheapest first. */
  rates: Rate[];
  /** Carriers expected but silent after every retry — a thin result the UI must show. */
  missingCarriers: string[];
  /** Carriers that answered with an error (bad address for UPS, …); not retried. */
  carrierMessages: { carrier: string; text: string }[];
  attempts: number;
};

export type Label = {
  /** 0-based parcel position in the shipment (Shippo's parcel order). */
  parcelIndex: number;
  transactionId: string;
  trackingNumber: string;
  labelUrl: string;
  /** ZPL text, downloaded at buy time so reprints never call Shippo. */
  zpl: string;
};

/** Shippo tracking statuses (track_updated webhook). */
export type TrackingStatus =
  "PRE_TRANSIT" | "TRANSIT" | "DELIVERED" | "RETURNED" | "FAILURE" | "UNKNOWN";

export type TrackingUpdate = {
  carrier: string;
  trackingNumber: string;
  transactionId: string | null;
  status: TrackingStatus;
  statusDate: string | null;
  details: string | null;
  test: boolean;
};
