// WP-19 route-handler flow against the local Supabase with recorded Shippo fixtures (fake
// fetch): the desk's own session for reads and claims, the service role for provider results —
// exactly what the /api/shipping/* handlers wire up. Verify → rate shop (allowlist, thin-result
// retry) → choose → buy every parcel's label → print → tracking ships it; held / Buy Now
// (I13, I14); a partial label fetch retried without paying twice; Rate Check; not configured.
import type { FilletryClient, Json } from "db";
import { createHash, randomUUID } from "node:crypto";
import {
  fakeFetch,
  happyPathRoutes,
  shippoClient,
  shippoFixtures as f,
  type FakeFetch,
  type FakeRoute,
} from "shipping";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOrg,
  createUser,
  dropOrg,
  serviceRoleClient,
  type TestOrg,
  type TestUser,
} from "../../../../packages/db/src/testing/local-supabase";
import {
  ShippingRequestError,
  applyTracking,
  buyLabel,
  rateCheck,
  shopRates,
  verifyAddress,
  type ShippingDeps,
} from "./service";

type Shipment = {
  shipment_id: string;
  number: string;
  state: string;
  blockers: string[];
  ship_to: Record<string, string>;
  rate_shop: {
    rates: { rateId: string; carrier: string }[];
    attempts: number;
    missingCarriers: string[];
  } | null;
  buying: boolean;
  buy_error: string | null;
  gate: { held: boolean; blockers: string[]; can_buy: boolean; can_reprint: boolean };
  parcels: { tracking_number: string | null; has_label: boolean }[];
};

const admin = serviceRoleClient();
const cid = (p: string) => `${p}-${randomUUID()}`;
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const ELEVATION = `wp19-${randomUUID()}`;
const shipTo = {
  name: "Ann Angler",
  street1: "1200 W Dimond Blvd",
  city: "Anchorage",
  state: "AK",
  zip: "99515",
};

/** The real service client, except the Vault key (covered by 19_shipping VAULT checks). */
function withKey(key: string | null): FilletryClient {
  return new Proxy(admin, {
    get(target, prop, receiver) {
      if (prop === "rpc") {
        return (fn: string, args: unknown) =>
          fn === "shipping_api_key"
            ? Promise.resolve({ data: key, error: null })
            : (target.rpc as (fn: string, args: unknown) => unknown).call(target, fn, args);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** The fixtures with this test's own transaction ids / tracking numbers (both are unique). */
function tagged(routes: FakeRoute[], tag: string): FakeRoute[] {
  const retag = (v: unknown): unknown =>
    v === undefined
      ? v
      : JSON.parse(
          JSON.stringify(v).replaceAll("txn_2e1d", `txn_${tag}`).replaceAll("1Z999AA1", `1Z${tag}`),
        );
  return routes.map((r) => ({
    ...r,
    reply: (Array.isArray(r.reply) ? r.reply : [r.reply]).map((x) => ({
      ...x,
      json: retag(x.json),
    })),
  }));
}

describe("shipping route flow (recorded Shippo fixtures)", { timeout: 60_000 }, () => {
  let org: TestOrg;
  let staff: TestUser;
  let sessionId = "";
  let settlementId = "";
  let sizeId = "";
  let n = 0;

  function deps(
    routes: FakeRoute[],
    key: string | null = "shippo_test_placeholder",
  ): ShippingDeps & { fetch: FakeFetch } {
    const fetch = fakeFetch(routes);
    return {
      fetch,
      caller: staff.client,
      service: withKey(key),
      orgId: org.id,
      shippoFor: (apiKey) =>
        shippoClient({
          apiKey,
          fetch,
          sleep: async () => {},
          rateRetryDelaysMs: [1, 1, 1],
          labelPollDelaysMs: [1, 1],
        }),
    };
  }

  async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await (
      staff.client.rpc as (
        f: string,
        a: unknown,
      ) => PromiseLike<{ data: unknown; error: { message: string } | null }>
    )(fn, args);
    if (error) throw new Error(error.message);
    return data as T;
  }

  /** A shipment of `boxes` new ship boxes (40 lb each) shipping on `shipDate`. */
  async function shipment(
    boxes: number,
    shipDate: string | null,
    size = sizeId,
  ): Promise<Shipment> {
    const ids: string[] = [];
    for (let i = 0; i < boxes; i += 1) {
      n += 1;
      const { data, error } = await admin
        .from("box_plan")
        .insert({
          org_id: org.id,
          number: `BOX-${String(n).padStart(4, "0")}`,
          settlement_id: settlementId,
          session_id: sessionId,
          method: "ship",
          box_size_id: size,
          weight_lb: 40,
        })
        .select("id")
        .single();
      if (error) throw error;
      ids.push(data.id);
    }
    return rpc<Shipment>("create_shipment", {
      p_client_action_id: cid("create"),
      p_box_plan_ids: ids,
      p_ship_to: shipTo,
      p_ship_date: shipDate,
    });
  }

  /** Verified, rated and with UPS 2nd Day Air chosen. */
  async function readyToBuy(sh: Shipment, routes = happyPathRoutes()): Promise<void> {
    await verifyAddress(deps(routes), { shipmentId: sh.shipment_id });
    await shopRates(deps(routes), { shipmentId: sh.shipment_id });
    await rpc("select_shipment_rate", {
      p_client_action_id: cid("rate"),
      p_shipment_id: sh.shipment_id,
      p_rate_id: "rate_ups_2da",
    });
  }

  const detail = (id: string) => rpc<Shipment>("shipment_detail", { p_shipment_id: id });

  beforeAll(async () => {
    org = await createOrg();
    staff = await createUser(org, "staff");
    const manager = await createUser(org, "manager");
    const { data: member } = await admin
      .from("org_member")
      .select("id")
      .eq("user_id", manager.id)
      .single();
    const { data: site } = await admin
      .from("site")
      .insert({
        org_id: org.id,
        name: "Dock",
        is_default: true,
        ship_from: {
          name: "Kenai Plant",
          street1: "1 Dock Rd",
          city: "Kenai",
          state: "AK",
          zip: "99611",
          country: "US",
        },
      })
      .select("id")
      .single();
    const { data: size } = await admin
      .from("box_size")
      .insert({
        org_id: org.id,
        name: "Medium",
        max_lb: 50,
        dims: { length_in: 20, width_in: 14, height_in: 12, packaging_lb: 2.5, dry_ice_lb: 10 },
      })
      .select("id")
      .single();
    const { data: session } = await admin
      .from("allocation_session")
      .insert({ org_id: org.id, number: "ALC-0001", state: "priced" })
      .select("id")
      .single();
    const { data: settlement } = await admin
      .from("settlement")
      .insert({ org_id: org.id, number: "STL-0001", session_id: session!.id, angler_name: "Ann" })
      .select("id")
      .single();
    await admin.from("printer").insert({
      org_id: org.id,
      name: "Ship Zebra",
      site_id: site!.id,
      kind: "label_zpl",
      is_default_for: { shipping_label: true },
    });
    await admin.from("elevation_grant").insert({
      org_id: org.id,
      requested_by: staff.id,
      manager_member_id: member!.id,
      token_hash: createHash("sha256").update(ELEVATION).digest("hex"),
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    sizeId = size!.id;
    sessionId = session!.id;
    settlementId = settlement!.id;
  });

  afterAll(async () => {
    if (org) await dropOrg(org);
  });

  it("verify → rates → buy every parcel's label → print → tracking ships it", async () => {
    const sh = await shipment(2, today());
    expect(sh.blockers).toEqual(["address_unverified"]);

    const verified = (await verifyAddress(deps(happyPathRoutes()), {
      shipmentId: sh.shipment_id,
    })) as {
      shipment: Shipment;
    };
    expect(verified.shipment.blockers).toEqual([]);
    expect(verified.shipment.ship_to.zip).toBe("99515-1234");

    const shopDeps = deps(happyPathRoutes());
    const rated = (await shopRates(shopDeps, { shipmentId: sh.shipment_id })) as {
      shipment: Shipment;
    };
    expect(rated.shipment.rate_shop?.rates).toHaveLength(6);
    // Cold chain: 40 lb fish + 2.5 packaging + 10 dry ice per box, dry ice declared.
    const sent = shopDeps.fetch.calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/shipments"),
    )!.body as {
      parcels: { weight: string }[];
      extra: { dry_ice: { weight: string } };
    };
    expect(sent.parcels.map((p) => p.weight)).toEqual(["52.50", "52.50"]);
    expect(sent.extra.dry_ice.weight).toBe("20.00");

    await rpc("select_shipment_rate", {
      p_client_action_id: cid("rate"),
      p_shipment_id: sh.shipment_id,
      p_rate_id: "rate_ups_2da",
    });
    const buyDeps = deps(happyPathRoutes());
    const bought = (await buyLabel(buyDeps, {
      clientActionId: cid("buy"),
      shipmentId: sh.shipment_id,
    })) as {
      status: string;
      shipment: Shipment;
    };
    expect(bought.status).toBe("bought");
    expect(bought.shipment.state).toBe("label_bought");
    expect(bought.shipment.parcels.map((p) => [p.tracking_number, p.has_label])).toEqual([
      ["1Z999AA10123456784", true],
      ["1Z999AA10123456791", true],
    ]);
    expect(buyDeps.fetch.count("/transactions", "POST")).toBe(1);

    const printed = await rpc<{ jobs: number }>("print_shipment_labels", {
      p_client_action_id: cid("print"),
      p_shipment_id: sh.shipment_id,
    });
    expect(printed.jobs).toBe(2);

    await admin
      .from("box_plan")
      .update({ fulfillment_state: "packed" })
      .eq("shipment_id", sh.shipment_id);
    const tracked = (await applyTracking(admin, f.trackUpdatedTransit)) as { state: string };
    expect(tracked.state).toBe("shipped");
    const { data: boxes } = await admin
      .from("box_plan")
      .select("fulfillment_state")
      .eq("shipment_id", sh.shipment_id);
    expect(boxes?.map((b) => b.fulfillment_state)).toEqual(["shipped", "shipped"]);
    expect(await applyTracking(admin, { event: "transaction_created", data: {} })).toEqual({
      ignored: true,
    });
  });

  it("allowlist + thin-result retry: re-quoted until every allowed carrier answers", async () => {
    const { data: o } = await admin.from("org").select("settings").eq("id", org.id).single();
    const settings = o!.settings as { shipping: Record<string, Json> };
    await admin
      .from("org")
      .update({
        settings: {
          ...settings,
          shipping: { ...settings.shipping, carrier_allowlist: ["ups", "fedex"] },
        },
      })
      .eq("id", org.id);
    try {
      const sh = await shipment(1, today());
      await verifyAddress(deps(happyPathRoutes()), { shipmentId: sh.shipment_id });
      const thin: FakeRoute = {
        method: "POST",
        url: "/shipments",
        reply: [{ json: f.shipmentThin }, { json: f.shipmentFull }],
      };
      const d = deps([thin, ...happyPathRoutes()]);
      const rated = (await shopRates(d, { shipmentId: sh.shipment_id })) as { shipment: Shipment };
      expect(d.fetch.count("/shipments", "POST")).toBe(2);
      expect(rated.shipment.rate_shop?.attempts).toBe(2);
      expect(new Set(rated.shipment.rate_shop?.rates.map((r) => r.carrier))).toEqual(
        new Set(["ups", "fedex"]),
      );
    } finally {
      await admin.from("org").update({ settings }).eq("id", org.id);
    }
  });

  it("I13 held: reported with no Shippo call; I14 manager Buy Now buys it", async () => {
    const sh = await shipment(1, inDays(5));
    await readyToBuy(sh);
    const d = deps(tagged(happyPathRoutes(), "held"));
    const held = (await buyLabel(d, {
      clientActionId: cid("buy"),
      shipmentId: sh.shipment_id,
    })) as {
      status: string;
      held: boolean;
      blockers: string[];
    };
    expect(held).toMatchObject({ status: "not_bought", held: true, blockers: [] });
    expect(d.fetch.calls).toHaveLength(0);

    await expect(
      buyLabel(d, {
        clientActionId: cid("buy"),
        shipmentId: sh.shipment_id,
        forceBuyHeld: true,
        elevationToken: "nope",
      }),
    ).rejects.toMatchObject({ status: 403 });

    const forced = (await buyLabel(d, {
      clientActionId: cid("buy"),
      shipmentId: sh.shipment_id,
      forceBuyHeld: true,
      elevationToken: ELEVATION,
    })) as { status: string; shipment: Shipment };
    expect(forced.status).toBe("bought");
    expect(forced.shipment.gate.can_reprint).toBe(true);
  });

  it("labels still missing → 502, claim released; the retry adopts them and never pays twice", async () => {
    const sh = await shipment(2, today());
    await readyToBuy(sh);
    const list = (json: unknown) => ({ json });
    const routes: FakeRoute[] = [
      {
        method: "GET",
        url: "/transactions?rate=",
        reply: [
          list(f.transactionsNone),
          list(f.transactionsPartial),
          list(f.transactionsPartial),
          list(f.transactionsPartial),
          list(f.transactionsAll),
        ],
      },
      ...happyPathRoutes(),
    ];
    const d = deps(tagged(routes, "adopt"));
    const err = await buyLabel(d, { clientActionId: cid("buy"), shipmentId: sh.shipment_id }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ShippingRequestError);
    expect(err).toMatchObject({ status: 502, code: "labels_incomplete" });
    const after = await detail(sh.shipment_id);
    expect(after).toMatchObject({ state: "draft", buying: false });
    expect(after.buy_error).toMatch(/only 1 of 2 labels/);

    const retry = (await buyLabel(d, {
      clientActionId: cid("buy"),
      shipmentId: sh.shipment_id,
    })) as {
      status: string;
      adopted: boolean;
    };
    expect(retry).toMatchObject({ status: "bought", adopted: true });
    expect(d.fetch.count("/transactions", "POST")).toBe(1);
  });

  it("Rate Check bypasses the allowlist; the freight quote is the cheapest rate", async () => {
    const quote = await rateCheck(deps(happyPathRoutes()), {
      to: { ...shipTo, country: "US" },
      parcels: [{ length_in: 20, width_in: 14, height_in: 12, weight_lb: 50, dry_ice_lb: 10 }],
      bypassAllowlist: true,
    });
    expect(new Set(quote.rates.map((r) => r.carrier))).toEqual(new Set(["usps", "ups", "fedex"]));
    expect(quote.cheapest).toMatchObject({ carrier: "usps", amount: 64.1 });
  });

  it("refuses clearly: no Shippo key, a box size without dims", async () => {
    const sh = await shipment(1, today());
    await expect(
      verifyAddress(deps(happyPathRoutes(), null), { shipmentId: sh.shipment_id }),
    ).rejects.toMatchObject({
      status: 503,
      code: "not_configured",
    });
    const { data: bare } = await admin
      .from("box_size")
      .insert({ org_id: org.id, name: "No dims", max_lb: 50 })
      .select("id")
      .single();
    const noDims = await shipment(1, today(), bare!.id);
    await expect(
      shopRates(deps(happyPathRoutes()), { shipmentId: noDims.shipment_id }),
    ).rejects.toMatchObject({
      status: 422,
      code: "parcel_incomplete",
    });
  });
});
