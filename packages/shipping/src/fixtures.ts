// Shippo responses in the API's documented shapes (test-mode object ids, test tracking
// numbers). Used by this package's tests and the /api/shipping route tests; no live key or
// customer data is involved.
import addressInvalid from "./fixtures/address-invalid.json";
import addressValid from "./fixtures/address-valid.json";
import carrierAccounts from "./fixtures/carrier-accounts.json";
import shipmentEmpty from "./fixtures/shipment-empty.json";
import shipmentFull from "./fixtures/shipment-full.json";
import shipmentThin from "./fixtures/shipment-thin.json";
import shipmentUpsError from "./fixtures/shipment-ups-error.json";
import trackUpdatedTransit from "./fixtures/track-updated-transit.json";
import transactionError from "./fixtures/transaction-error.json";
import transactionSuccess from "./fixtures/transaction-success.json";
import transactionsAll from "./fixtures/transactions-by-rate-all.json";
import transactionsNone from "./fixtures/transactions-by-rate-none.json";
import transactionsPartial from "./fixtures/transactions-by-rate-partial.json";
import type { FakeRoute } from "./fake.ts";

/** ZPL a label URL serves (fixtures/label.zpl). */
export const LABEL_ZPL =
  "^XA\n^CI28\n^FO40,40^A0N,40,40^FDUPS 2ND DAY AIR^FS\n^FO40,100^BCN,120,Y,N,N^FD1Z999AA10123456784^FS\n^XZ\n";

export const shippoFixtures = {
  addressInvalid,
  addressValid,
  carrierAccounts,
  shipmentEmpty,
  shipmentFull,
  shipmentThin,
  shipmentUpsError,
  trackUpdatedTransit,
  transactionError,
  transactionSuccess,
  transactionsAll,
  transactionsNone,
  transactionsPartial,
} as const;

/** A two-parcel happy path: valid address, full rates, buy UPS 2nd Day Air, both labels. */
export function happyPathRoutes(): FakeRoute[] {
  const f = shippoFixtures;
  return [
    { method: "GET", url: "/carrier_accounts", reply: { json: f.carrierAccounts } },
    { method: "POST", url: "/addresses", reply: { json: f.addressValid } },
    { method: "POST", url: "/shipments", reply: { json: f.shipmentFull } },
    { method: "GET", url: "/shipments/", reply: { json: f.shipmentFull } },
    {
      method: "GET",
      url: "/transactions?rate=",
      reply: [{ json: f.transactionsNone }, { json: f.transactionsAll }],
    },
    { method: "POST", url: "/transactions", reply: { json: f.transactionSuccess } },
    { method: "GET", url: "deliver.goshippo.com", reply: { text: LABEL_ZPL } },
  ];
}
