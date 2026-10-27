// The /api/shipping/* flows (docs/07-INTEGRATIONS.md §4). Each step reads and claims as the
// CALLER (RLS + action_log), talks to Shippo with the org's key from Vault, and records the
// provider's answer through a service-role-only SQL function — so the browser can never record
// a Shippo result (a "bought" label it did not pay for, a "verified" address it did not check).
import type { FilletryClient, Json } from "db";
import {
  LabelsIncompleteError,
  ShippoError,
  addressGaps,
  boxParcel,
  isInCarrierHands,
  parseTrackingEvent,
  walkinParcel,
  type Address,
  type Allowlist,
  type BoxSizeDims,
  type Parcel,
  type RateShop,
  type ShippoClient,
} from "shipping";

export class ShippingRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ShippingRequestError";
  }
}

export type ShippingDeps = {
  /** The caller's own session: staff cookie or a paired station's bearer token. */
  caller: FilletryClient;
  /** Service role: Vault key + recording provider results. Route handlers only. */
  service: FilletryClient;
  orgId: string;
  /** The paired station's device (its site's ship-from), null for a staff session. */
  deviceId: string | null;
  /** Local dev only (.env.example): SHIPPO_API_KEY when the org has no Vault key. Null in prod. */
  devFallbackKey?: string | null;
  /** Builds the Shippo client for the org's key (tests pass a fixture-backed fake). */
  shippoFor: (apiKey: string) => ShippoClient;
};

type ParcelRow = {
  seq: number;
  kind: "box" | "walkin";
  box_number: string | null;
  weight_lb: number;
  dims: BoxSizeDims | null;
};

export type ShipmentDetail = {
  shipment_id: string;
  number: string;
  state: string;
  ship_to: Partial<Address>;
  ship_from: Partial<Address> | null;
  shippo_rate_id: string | null;
  shippo_shipment_id: string | null;
  allowlist: Allowlist;
  parcels: ParcelRow[];
};

function sqlError(error: { message: string; code?: string } | null): ShippingRequestError | null {
  if (!error) return null;
  const status =
    error.code === "P0002"
      ? 404
      : error.code === "42501"
        ? 403
        : error.code === "55000" || error.code === "55006"
          ? 409
          : 400;
  return new ShippingRequestError(error.message, status, error.code ?? null);
}

async function rpc<T>(
  call: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>,
): Promise<T> {
  const { data, error } = await call;
  const err = sqlError(error);
  if (err) throw err;
  return data as T;
}

async function detail(deps: ShippingDeps, shipmentId: string): Promise<ShipmentDetail> {
  return rpc<ShipmentDetail>(deps.caller.rpc("shipment_detail", { p_shipment_id: shipmentId }));
}

async function shippo(deps: ShippingDeps): Promise<ShippoClient> {
  const vaultKey = await rpc<string | null>(
    deps.service.rpc("shipping_api_key", { p_org_id: deps.orgId }),
  );
  const key = vaultKey ?? deps.devFallbackKey ?? null;
  if (!key) {
    throw new ShippingRequestError(
      "Shipping is not set up for this plant (no Shippo key in Vault)",
      503,
      "not_configured",
    );
  }
  return deps.shippoFor(key);
}

/** Shippo failures → a message the desk can act on; never the key, never raw bodies. */
function providerError(e: unknown): never {
  if (e instanceof ShippingRequestError) throw e;
  if (e instanceof LabelsIncompleteError)
    throw new ShippingRequestError(e.message, 502, "labels_incomplete");
  if (e instanceof ShippoError) throw new ShippingRequestError(e.message, 502, "shippo");
  throw new ShippingRequestError("Shippo could not be reached; try again", 502, "shippo");
}

function requireAddress(a: Partial<Address> | null | undefined, what: string): Address {
  const gaps = addressGaps(a);
  if (gaps.length) {
    throw new ShippingRequestError(
      `${what} is missing: ${gaps.join(", ")}`,
      422,
      "address_incomplete",
    );
  }
  return a as Address;
}

/** Shippo parcels for a shipment; names the box whose size lacks dims or weight. */
export function shipmentParcels(rows: readonly ParcelRow[]): Parcel[] {
  return rows.map((r) => {
    const parcel =
      r.kind === "box"
        ? boxParcel({ weight_lb: r.weight_lb, dims: r.dims })
        : walkinParcel({
            length_in: Number(r.dims?.length_in),
            width_in: Number(r.dims?.width_in),
            height_in: Number(r.dims?.height_in),
            weight_lb: r.weight_lb,
            dry_ice_lb: Number(r.dims?.dry_ice_lb ?? 0),
          });
    if (!parcel) {
      throw new ShippingRequestError(
        `${r.box_number ?? `Parcel ${r.seq + 1}`} has no weight or its box size has no L×W×H; fix it in Box sizes`,
        422,
        "parcel_incomplete",
      );
    }
    return parcel;
  });
}

/** Address validate → the shipment's address blockers. */
export async function verifyAddress(
  deps: ShippingDeps,
  input: { shipmentId: string },
): Promise<Json> {
  const sh = await detail(deps, input.shipmentId);
  const to = requireAddress(sh.ship_to, "The ship-to address");
  const client = await shippo(deps);
  const check = await client.validateAddress(to).catch(providerError);
  return rpc<Json>(
    deps.service.rpc("shipping_record_address", {
      p_org_id: deps.orgId,
      p_shipment_id: sh.shipment_id,
      p_checked: sh.ship_to as Json,
      p_valid: check.valid,
      p_normalized: (check.normalized ?? null) as Json,
      p_messages: check.messages,
    }),
  );
}

/** Rate shop for a shipment: allowlisted rates, thin-result retry. */
export async function shopRates(deps: ShippingDeps, input: { shipmentId: string }): Promise<Json> {
  const sh = await detail(deps, input.shipmentId);
  if (!["draft", "held"].includes(sh.state)) {
    throw new ShippingRequestError(`${sh.number} already has its label`, 409);
  }
  const from = requireAddress(sh.ship_from, "This site's ship-from address (Admin → Sites)");
  const to = requireAddress(sh.ship_to, "The ship-to address");
  const parcels = shipmentParcels(sh.parcels);
  const client = await shippo(deps);
  const shop = await client
    .rateShop({ from, to, parcels, allowlist: sh.allowlist, metadata: sh.number })
    .catch(providerError);
  return rpc<Json>(
    deps.service.rpc("shipping_record_rates", {
      p_org_id: deps.orgId,
      p_shipment_id: sh.shipment_id,
      p_checked: sh.ship_to as Json,
      p_shop: shop as unknown as Json,
    }),
  );
}

type BeginBuy = {
  ok: boolean;
  shipment_id: string;
  number: string;
  held: boolean;
  blockers: string[];
  /** The purchase claim begin_label_buy issued — NOT permission to pay (see below). */
  claim_id?: string;
  /** True when the client_action_id was already used: the stored claim, likely spent. */
  replayed?: boolean;
};

type StartedPurchase = {
  shipment_id: string;
  number: string;
  claim_id: string;
  rate_id: string;
  shippo_shipment_id: string | null;
  parcel_count: number;
};

/**
 * Buy the label(s), in three steps:
 *  1. begin_label_buy (as the caller): the I13 / I13b / I14 gate and a purchase CLAIM. A held or
 *     blocked shipment comes back as `{ok:false, held, blockers}` — reported, never thrown.
 *  2. shipping_start_purchase (service role): consumes the claim exactly once and re-checks the
 *     shipment as it is now. This — not the claim — is the permission to call Shippo, so a
 *     replayed or concurrent duplicate request, or a claim overtaken by a failure / cancel /
 *     edit, is refused before any money moves.
 *  3. Shippo (adopting any transaction already bought for the rate), then record the labels
 *     against the same claim. If this handler started the purchase and anything fails, it
 *     reports the failure (clearing its claim); the next Buy adopts what Shippo sold.
 */
export async function buyLabel(
  deps: ShippingDeps,
  input: {
    clientActionId: string;
    shipmentId: string;
    forceBuyHeld?: boolean;
    elevationToken?: string | null;
  },
): Promise<Json> {
  const begin = await rpc<BeginBuy>(
    deps.caller.rpc("begin_label_buy", {
      p_client_action_id: input.clientActionId,
      p_shipment_id: input.shipmentId,
      p_force_buy_held: input.forceBuyHeld ?? false,
      p_elevation_token: input.elevationToken ?? undefined,
    }),
  );
  if (!begin.ok) return { status: "not_bought", ...begin } as unknown as Json;

  // Throws (409) unless this request holds the live, unstarted claim. Nothing to report then:
  // the claim, if any, belongs to whoever started it.
  const started = await rpc<StartedPurchase>(
    deps.service.rpc("shipping_start_purchase", {
      p_org_id: deps.orgId,
      p_shipment_id: begin.shipment_id,
      p_claim_id: begin.claim_id as string,
    }),
  );

  let client: ShippoClient | null = null;
  try {
    if (!started.shippo_shipment_id || started.parcel_count < 1) {
      throw new ShippingRequestError("Shop rates again before buying", 409, "no_rate");
    }
    client = await shippo(deps);
    const { labels, adopted } = await client
      .buyLabels({
        shippoShipmentId: started.shippo_shipment_id,
        rateId: started.rate_id,
        parcelCount: started.parcel_count,
        metadata: started.number,
      })
      .catch(providerError);
    const shipment = await rpc<Json>(
      deps.service.rpc("shipping_record_labels", {
        p_org_id: deps.orgId,
        p_shipment_id: started.shipment_id,
        p_claim_id: started.claim_id,
        p_rate_id: started.rate_id,
        p_labels: labels as unknown as Json,
      }),
    );
    return { status: "bought", adopted, shipment } as unknown as Json;
  } catch (e) {
    const reason = e instanceof Error ? e.message : "label purchase failed";
    // Did Shippo sell anything for this rate? Never reached Shippo → no; Shippo lists a live
    // transaction → yes; cannot tell → unknown (null). Only "no" unpins the rate.
    const charged = client ? await client.hasPurchase(started.rate_id).catch(() => null) : false;
    await deps.service.rpc("shipping_buy_failed", {
      p_org_id: deps.orgId,
      p_shipment_id: started.shipment_id,
      p_claim_id: started.claim_id,
      p_error: reason,
      p_charged: charged as boolean, // null = unknown; the generated type cannot say so
    });
    throw e;
  }
}

/**
 * Rate Check (and the freight quote stub): quote any address and parcels from this site's
 * ship-from. `bypassAllowlist` shows every carrier the account has (Rate Check); without it
 * the cheapest allowlisted rate is the freight quote. Nothing is stored and nothing can be
 * bought from a quote.
 */
export async function rateCheck(
  deps: ShippingDeps,
  input: { to: Address; parcels: Parcel[]; bypassAllowlist: boolean },
): Promise<RateShop & { cheapest: RateShop["rates"][number] | null }> {
  const deviceId = deps.deviceId;
  const [{ data: device }, { data: sites }, { data: org }] = await Promise.all([
    deviceId
      ? deps.caller.from("device").select("site_id").eq("id", deviceId).maybeSingle()
      : Promise.resolve({ data: null }),
    deps.caller.from("site").select("id, is_default, ship_from"),
    deps.caller.from("org").select("settings").eq("id", deps.orgId).maybeSingle(),
  ]);
  const site =
    (sites ?? []).find((s) => s.id === device?.site_id) ?? (sites ?? []).find((s) => s.is_default);
  const from = requireAddress(
    site?.ship_from as Partial<Address> | null,
    "This site's ship-from address",
  );
  const to = requireAddress(input.to, "The ship-to address");
  const settings = (org?.settings ?? {}) as { shipping?: { carrier_allowlist?: Allowlist } };
  const client = await shippo(deps);
  const shop = await client
    .rateShop({
      from,
      to,
      parcels: input.parcels,
      allowlist: settings.shipping?.carrier_allowlist ?? "*",
      bypassAllowlist: input.bypassAllowlist,
    })
    .catch(providerError);
  return { ...shop, cheapest: shop.rates[0] ?? null };
}

/**
 * Shippo track_updated → shipment state, for the org whose webhook credential the route
 * verified; only that org's parcels can match. Unknown events and numbers are acknowledged.
 */
export async function applyTracking(
  service: FilletryClient,
  orgId: string,
  body: unknown,
): Promise<Json> {
  const update = parseTrackingEvent(body);
  if (!update) return { ignored: true };
  return rpc<Json>(
    service.rpc("shipping_apply_tracking", {
      p_org_id: orgId,
      // null when absent; the generated RPC type cannot express a nullable text arg.
      p_transaction_id: update.transactionId as string,
      p_tracking_number: update.trackingNumber,
      p_status: update.status,
      p_in_carrier_hands: isInCarrierHands(update.status),
      p_details: update.details as string,
    }),
  );
}
