import { describe, expect, it } from "vitest";
import { fakeFetch, type FakeRoute } from "./fake.ts";
import { happyPathRoutes, LABEL_ZPL, shippoFixtures as f } from "./fixtures.ts";
import { LabelsIncompleteError, ShippoError, carrierToken, shippoClient } from "./shippo.ts";
import type { Address, Parcel } from "./types.ts";

const KEY = "shippo_test_" + "0".repeat(40); // a placeholder, never a real key
const noSleep = async () => {};

const from: Address = {
  name: "Kenai Plant",
  street1: "1 Dock Rd",
  city: "Kenai",
  state: "AK",
  zip: "99611",
  country: "US",
};
const to: Address = {
  name: "Pat Party",
  street1: "1200 W Dimond Blvd",
  city: "Anchorage",
  state: "AK",
  zip: "99515",
  country: "US",
};
const parcels: Parcel[] = [
  { length_in: 20, width_in: 14, height_in: 12, weight_lb: 52.5, dry_ice_lb: 10 },
  { length_in: 20, width_in: 14, height_in: 12, weight_lb: 48, dry_ice_lb: 10 },
];

function client(routes: FakeRoute[]) {
  const fetch = fakeFetch(routes);
  const sleeps: number[] = [];
  const shippo = shippoClient({
    apiKey: KEY,
    fetch,
    sleep: async (ms) => void sleeps.push(ms),
    rateRetryDelaysMs: [10, 20, 40],
    labelPollDelaysMs: [10, 20],
  });
  return { shippo, fetch, sleeps };
}

/** The happy path with some replies replaced: the fake answers with the first matching route. */
function routesWith(overrides: FakeRoute[]): FakeRoute[] {
  return [...overrides, ...happyPathRoutes()];
}

describe("address validate", () => {
  it("valid address comes back carrier-normalised", async () => {
    const { shippo, fetch } = client(happyPathRoutes());
    const check = await shippo.validateAddress(to);
    expect(check.valid).toBe(true);
    expect(check.normalized).toMatchObject({ street1: "1200 W DIMOND BLVD", zip: "99515-1234" });
    expect(fetch.calls[0]!.body).toMatchObject({ validate: true, street1: to.street1 });
  });

  it("invalid address reports the carrier's reason and no normalised address", async () => {
    const { shippo } = client([
      { method: "POST", url: "/addresses", reply: { json: f.addressInvalid } },
    ]);
    const check = await shippo.validateAddress({ ...to, street1: "1 Nowhere Ln" });
    expect(check).toMatchObject({ valid: false, normalized: null });
    expect(check.messages[0]).toMatch(/could not be found/);
  });
});

describe("rate shop", () => {
  it("allowlist: only allowed carriers are offered, cheapest first", async () => {
    const { shippo } = client(happyPathRoutes());
    const shop = await shippo.rateShop({ from, to, parcels, allowlist: ["ups", "fedex"] });
    expect(shop.rates.map((r) => r.carrier)).toEqual(["fedex", "ups", "fedex", "ups"]);
    expect(shop.rates.map((r) => r.amount)).toEqual([118.4, 121.75, 175.2, 189.3]);
    expect(shop.missingCarriers).toEqual([]);
    expect(shop.shippoShipmentId).toBe(f.shipmentFull.object_id);
  });

  it("allowlist `*` offers every active carrier", async () => {
    const { shippo } = client(happyPathRoutes());
    const shop = await shippo.rateShop({ from, to, parcels, allowlist: "*" });
    expect(new Set(shop.rates.map((r) => r.carrier))).toEqual(new Set(["usps", "ups", "fedex"]));
  });

  it("Rate Check bypasses the allowlist", async () => {
    const { shippo } = client(happyPathRoutes());
    const shop = await shippo.rateShop({
      from,
      to,
      parcels,
      allowlist: ["ups"],
      bypassAllowlist: true,
    });
    expect(new Set(shop.rates.map((r) => r.carrier))).toEqual(new Set(["usps", "ups", "fedex"]));
  });

  it("thin-result retry: a partial carrier set (not just empty) is re-quoted until full", async () => {
    const { shippo, fetch, sleeps } = client(
      routesWith([
        {
          method: "POST",
          url: "/shipments",
          reply: [{ json: f.shipmentThin }, { json: f.shipmentThin }, { json: f.shipmentFull }],
        },
      ]),
    );
    const shop = await shippo.rateShop({ from, to, parcels, allowlist: "*" });
    expect(fetch.count("/shipments", "POST")).toBe(3);
    expect(sleeps).toEqual([10, 20]);
    expect(shop.attempts).toBe(3);
    expect(shop.missingCarriers).toEqual([]);
    expect(new Set(shop.rates.map((r) => r.carrier)).size).toBe(3);
  });

  it("thin-result retry: an empty answer is retried too", async () => {
    const { shippo, fetch } = client(
      routesWith([
        {
          method: "POST",
          url: "/shipments",
          reply: [{ json: f.shipmentEmpty }, { json: f.shipmentFull }],
        },
      ]),
    );
    const shop = await shippo.rateShop({ from, to, parcels, allowlist: "*" });
    expect(fetch.count("/shipments", "POST")).toBe(2);
    expect(shop.rates.length).toBe(6);
  });

  it("thin-result retry gives up after the last delay and reports the silent carriers", async () => {
    const { shippo, fetch } = client(
      routesWith([{ method: "POST", url: "/shipments", reply: { json: f.shipmentThin } }]),
    );
    const shop = await shippo.rateShop({ from, to, parcels, allowlist: "*" });
    expect(fetch.count("/shipments", "POST")).toBe(4); // 1 + 3 retries
    expect(shop.missingCarriers).toEqual(["fedex", "ups"]);
    expect(shop.rates.every((r) => r.carrier === "usps")).toBe(true);
  });

  it("a carrier that answered with an error is not waited for", async () => {
    const { shippo, fetch } = client(
      routesWith([{ method: "POST", url: "/shipments", reply: { json: f.shipmentUpsError } }]),
    );
    const shop = await shippo.rateShop({ from, to, parcels, allowlist: "*" });
    expect(fetch.count("/shipments", "POST")).toBe(1);
    expect(shop.missingCarriers).toEqual([]);
    expect(shop.carrierMessages).toEqual([
      { carrier: "ups", text: "Ship To address is invalid for UPS." },
    ]);
  });

  it("a carrier outside the allowlist being silent is not thin", async () => {
    const { shippo, fetch } = client(
      routesWith([{ method: "POST", url: "/shipments", reply: { json: f.shipmentThin } }]),
    );
    const shop = await shippo.rateShop({ from, to, parcels, allowlist: ["usps"] });
    expect(fetch.count("/shipments", "POST")).toBe(1);
    expect(shop.missingCarriers).toEqual([]);
  });

  it("cold chain: gross parcel weight and dry ice are sent to Shippo", async () => {
    const { shippo, fetch } = client(happyPathRoutes());
    await shippo.rateShop({ from, to, parcels, allowlist: "*", metadata: "SHP-0001" });
    const body = fetch.calls.find((c) => c.method === "POST" && c.url.endsWith("/shipments"))!
      .body as {
      parcels: { weight: string; mass_unit: string }[];
      extra: { dry_ice: { contains_dry_ice: boolean; weight: string } };
      metadata: string;
    };
    expect(body.parcels.map((p) => p.weight)).toEqual(["52.50", "48.00"]);
    expect(body.parcels[0]!.mass_unit).toBe("lb");
    expect(body.extra.dry_ice).toEqual({ contains_dry_ice: true, weight: "20.00" });
    expect(body.metadata).toBe("SHP-0001");
  });
});

describe("buy label per parcel", () => {
  const buy = {
    shippoShipmentId: f.shipmentFull.object_id,
    rateId: "rate_ups_2da",
    parcelCount: 2,
    metadata: "SHP-0001",
  };

  it("multi-parcel: buys once and fetches EVERY parcel's label, in parcel order", async () => {
    const { shippo, fetch } = client(happyPathRoutes());
    const { labels, adopted } = await shippo.buyLabels(buy);
    expect(adopted).toBe(false);
    expect(fetch.count("/transactions", "POST")).toBe(1);
    expect(labels.map((l) => [l.parcelIndex, l.trackingNumber])).toEqual([
      [0, "1Z999AA10123456784"],
      [1, "1Z999AA10123456791"],
    ]);
    expect(labels.every((l) => l.zpl === LABEL_ZPL)).toBe(true);
    expect(fetch.count("deliver.goshippo.com")).toBe(2);
    const purchase = fetch.calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/transactions"),
    )!;
    expect(purchase.body).toMatchObject({ rate: "rate_ups_2da", label_file_type: "ZPLII" });
  });

  it("polls until the remaining labels are ready", async () => {
    const { shippo, sleeps } = client(
      routesWith([
        {
          method: "GET",
          url: "/transactions?rate=",
          reply: [
            { json: f.transactionsNone },
            { json: f.transactionsPartial },
            { json: f.transactionsAll },
          ],
        },
      ]),
    );
    const { labels } = await shippo.buyLabels(buy);
    expect(labels).toHaveLength(2);
    expect(sleeps).toEqual([10]);
  });

  it("labels still missing after polling → LabelsIncompleteError (the retry adopts, never re-buys)", async () => {
    const { shippo } = client(
      routesWith([
        {
          method: "GET",
          url: "/transactions?rate=",
          reply: [{ json: f.transactionsNone }, { json: f.transactionsPartial }],
        },
      ]),
    );
    const err = await shippo.buyLabels(buy).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LabelsIncompleteError);
    expect(err).toMatchObject({ ready: 1, expected: 2 });
  });

  it("adopts existing transactions for the rate instead of paying twice", async () => {
    const { shippo, fetch } = client(
      routesWith([
        { method: "GET", url: "/transactions?rate=", reply: { json: f.transactionsAll } },
      ]),
    );
    const { labels, adopted } = await shippo.buyLabels(buy);
    expect(adopted).toBe(true);
    expect(fetch.count("/transactions", "POST")).toBe(0);
    expect(labels).toHaveLength(2);
  });

  it("a refused purchase surfaces the carrier's reason", async () => {
    const { shippo } = client(
      routesWith([{ method: "POST", url: "/transactions", reply: { json: f.transactionError } }]),
    );
    await expect(shippo.buyLabels(buy)).rejects.toThrow(/rate has expired/);
  });

  it("the Shippo token goes to the API only, never to a label URL", async () => {
    const { shippo, fetch } = client(happyPathRoutes());
    await shippo.buyLabels(buy);
    for (const c of fetch.calls) {
      expect(c.authorized).toBe(c.url.startsWith("https://api.goshippo.com/"));
    }
  });
});

describe("was anything bought for a rate?", () => {
  it("live transactions → yes; none or only failed ones → no", async () => {
    const at = (json: unknown) =>
      client([{ method: "GET", url: "/transactions?rate=", reply: { json } }]).shippo;
    expect(await at(f.transactionsAll).hasPurchase("rate_ups_2da")).toBe(true);
    expect(await at(f.transactionsNone).hasPurchase("rate_ups_2da")).toBe(false);
    expect(await at({ results: [f.transactionError] }).hasPurchase("rate_ups_2da")).toBe(false);
  });
});

describe("errors never carry the key", () => {
  it("an HTTP error names the call and Shippo's detail only", async () => {
    const { shippo } = client([
      {
        method: "POST",
        url: "/addresses",
        reply: { status: 401, json: { detail: "Invalid token." } },
      },
    ]);
    const err = (await shippo.validateAddress(to).catch((e: unknown) => e)) as ShippoError;
    expect(err).toBeInstanceOf(ShippoError);
    expect(err.status).toBe(401);
    expect(err.message).toContain("Invalid token.");
    expect(err.message).not.toContain(KEY);
  });

  it("no key → not configured, before any call", () => {
    expect(() => shippoClient({ apiKey: "", fetch: fakeFetch([]), sleep: noSleep })).toThrow(
      /not configured/,
    );
  });
});

describe("carrier tokens", () => {
  it("normalises display names to allowlist tokens", () => {
    expect(["USPS", "UPS", "FedEx", "DHL Express"].map(carrierToken)).toEqual([
      "usps",
      "ups",
      "fedex",
      "dhl_express",
    ]);
  });
});
