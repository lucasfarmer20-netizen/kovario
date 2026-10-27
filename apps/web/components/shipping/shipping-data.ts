"use client";
import { withAction, type FilletryClient, type Json } from "db";
import type { Address, Parcel, RateShop } from "shipping";
import type { Queue, Shipment } from "./shipping-state";

// Station-side calls for /shipping. Desk actions are SQL functions keyed by a client_action_id
// (withAction); anything that talks to Shippo goes through the /api/shipping/* route handlers,
// which hold the Shippo key and record the carrier's answer server-side.

function unwrap<T>({ data, error }: { data: unknown; error: { message: string } | null }): T {
  if (error) throw new Error(error.message);
  return data as T;
}

async function act<T>(
  client: FilletryClient,
  fn: (id: string) => PromiseLike<{ data: Json; error: { message: string } | null }>,
): Promise<T> {
  const result = await withAction(client, crypto.randomUUID(), async (id) =>
    unwrap<Json>(await fn(id)),
  );
  return result as unknown as T;
}

export async function loadQueue(client: FilletryClient): Promise<Queue> {
  return unwrap<Queue>(await client.rpc("shipping_queue", { p_days: 14 }));
}

export async function loadShipment(client: FilletryClient, id: string): Promise<Shipment> {
  return unwrap<Shipment>(await client.rpc("shipment_detail", { p_shipment_id: id }));
}

export const createShipment = (
  client: FilletryClient,
  boxIds: string[],
  shipTo: Partial<Address>,
  shipDate: string | null,
) =>
  act<Shipment>(client, (id) =>
    client.rpc("create_shipment", {
      p_client_action_id: id,
      p_box_plan_ids: boxIds,
      p_ship_to: shipTo as Json,
      p_ship_date: shipDate as string, // null = no date yet (a blocker)
    }),
  );

export const createWalkin = (
  client: FilletryClient,
  customerId: string | null,
  shipTo: Partial<Address>,
  shipDate: string | null,
  parcels: Parcel[],
) =>
  act<Shipment>(client, (id) =>
    client.rpc("create_walkin_shipment", {
      p_client_action_id: id,
      p_customer_id: customerId as string,
      p_ship_to: shipTo as Json,
      p_ship_date: shipDate as string,
      p_parcels: parcels as unknown as Json,
    }),
  );

export const updateShipment = (
  client: FilletryClient,
  shipmentId: string,
  shipTo: Partial<Address>,
  shipDate: string | null,
) =>
  act<Shipment>(client, (id) =>
    client.rpc("update_shipment", {
      p_client_action_id: id,
      p_shipment_id: shipmentId,
      p_ship_to: shipTo as Json,
      p_ship_date: shipDate as string,
    }),
  );

export const selectRate = (client: FilletryClient, shipmentId: string, rateId: string) =>
  act<Shipment>(client, (id) =>
    client.rpc("select_shipment_rate", {
      p_client_action_id: id,
      p_shipment_id: shipmentId,
      p_rate_id: rateId,
    }),
  );

export const printLabels = (client: FilletryClient, shipmentId: string) =>
  act<{ jobs: number; printer_missing: boolean }>(client, (id) =>
    client.rpc("print_shipment_labels", { p_client_action_id: id, p_shipment_id: shipmentId }),
  );

export const markShipped = (client: FilletryClient, shipmentId: string) =>
  act<Shipment>(client, (id) =>
    client.rpc("mark_shipment_shipped", { p_client_action_id: id, p_shipment_id: shipmentId }),
  );

export const cancelShipment = (
  client: FilletryClient,
  shipmentId: string,
  reason: string,
  elevationToken: string | null,
) =>
  act<Shipment>(client, (id) =>
    client.rpc("cancel_shipment", {
      p_client_action_id: id,
      p_shipment_id: shipmentId,
      p_reason: reason,
      p_elevation_token: elevationToken ?? undefined,
    }),
  );

/** POST to /api/shipping/*, as this session (a paired station keeps its token in localStorage). */
async function api<T>(client: FilletryClient, path: string, body: unknown): Promise<T> {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(`/api/shipping/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Shipping request failed (${res.status})`);
  return json as T;
}

export const verifyAddress = (client: FilletryClient, shipmentId: string) =>
  api<{ stale: boolean; shipment: Shipment }>(client, "verify", { shipmentId });

export const shopRates = (client: FilletryClient, shipmentId: string) =>
  api<{ stale: boolean; shipment: Shipment }>(client, "rates", { shipmentId });

export type BuyResult =
  | { status: "bought"; adopted: boolean; shipment: Shipment }
  | { status: "not_bought"; held: boolean; blockers: string[]; number: string };

export const buyLabel = (
  client: FilletryClient,
  shipmentId: string,
  elevationToken: string | null = null,
) =>
  api<BuyResult>(client, "buy", {
    clientActionId: crypto.randomUUID(),
    shipmentId,
    forceBuyHeld: elevationToken !== null,
    elevationToken,
  });

export const rateCheck = (
  client: FilletryClient,
  to: Address,
  parcels: Parcel[],
  bypassAllowlist: boolean,
) =>
  api<RateShop & { cheapest: RateShop["rates"][number] | null }>(client, "rate-check", {
    to,
    parcels,
    bypassAllowlist,
  });
