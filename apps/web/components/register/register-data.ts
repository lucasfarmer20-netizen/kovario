"use client";
import { withAction, type FilletryClient, type Json } from "db";
import type { Cart, PaymentResult, TenderType } from "./register-state";

// Station-side calls for the register. Cart mutations are SQL functions keyed by a
// client_action_id (withAction), so a retried request replays instead of writing twice.
// Card / cash payments, Cancel, status checks and void / refund go through the
// /api/payments/* route handlers: the provider and its secret live only on the server.

function unwrap<T>({ data, error }: { data: T; error: { message: string } | null }): T {
  if (error) throw new Error(error.message);
  return data;
}

async function act<T>(
  client: FilletryClient,
  clientActionId: string,
  fn: (id: string) => PromiseLike<{ data: Json; error: { message: string } | null }>,
): Promise<T> {
  const result = await withAction(client, clientActionId, async (id) => unwrap(await fn(id)));
  return result as unknown as T;
}

/** Load outstanding: replaces every server line of the cart (S3); null order → a new cart. */
export function loadOutstanding(
  client: FilletryClient,
  clientActionId: string,
  customerId: string,
  orderId: string | null,
): Promise<Cart> {
  return act(client, clientActionId, (id) =>
    client.rpc("register_load_outstanding", {
      p_client_action_id: id,
      p_customer_id: customerId,
      p_order_id: orderId ?? undefined,
    }),
  );
}

export function addRetail(
  client: FilletryClient,
  clientActionId: string,
  orderId: string,
  productId: string,
  qty: number,
): Promise<Cart> {
  return act(client, clientActionId, (id) =>
    client.rpc("register_add_retail", {
      p_client_action_id: id,
      p_order_id: orderId,
      p_retail_product_id: productId,
      p_qty: qty,
    }),
  );
}

export function removeLine(
  client: FilletryClient,
  clientActionId: string,
  orderId: string,
  lineId: string,
): Promise<Cart> {
  return act(client, clientActionId, (id) =>
    client.rpc("register_remove_line", {
      p_client_action_id: id,
      p_order_id: orderId,
      p_line_id: lineId,
    }),
  );
}

export function voidCart(
  client: FilletryClient,
  clientActionId: string,
  orderId: string,
): Promise<Cart> {
  return act(client, clientActionId, (id) =>
    client.rpc("register_void_order", { p_client_action_id: id, p_order_id: orderId }),
  );
}

export async function readCart(client: FilletryClient, orderId: string): Promise<Cart> {
  return unwrap(await client.rpc("register_order", { p_order_id: orderId })) as unknown as Cart;
}

/** A manager marks an unresolved payment (the terminal cannot tell) with a reason. */
export function resolvePayment(
  client: FilletryClient,
  clientActionId: string,
  paymentId: string,
  outcome: "approved" | "declined" | "cancelled",
  reason: string,
  elevationToken: string,
): Promise<PaymentResult> {
  return act(client, clientActionId, (id) =>
    client.rpc("payment_resolve", {
      p_client_action_id: id,
      p_payment_id: paymentId,
      p_outcome: outcome,
      p_reason: reason,
      p_elevation_token: elevationToken,
    }),
  );
}

export type RetailProduct = { id: string; name: string; unit_price: number };
export type Terminal = { id: string; name: string; provider: string };

export async function listRetailProducts(client: FilletryClient): Promise<RetailProduct[]> {
  const { data, error } = await client
    .from("retail_product")
    .select("id, name, unit_price")
    .eq("is_active", true)
    .order("name");
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Active card terminals (the manual adapter needs none: cash / check / external / COMP). */
export async function listCardTerminals(client: FilletryClient): Promise<Terminal[]> {
  const { data, error } = await client
    .from("payment_terminal")
    .select("id, name, provider")
    .eq("is_active", true)
    .neq("provider", "manual")
    .order("name");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function paymentReceipt(client: FilletryClient, paymentId: string): Promise<Json> {
  return unwrap(await client.rpc("payment_receipt", { p_payment_id: paymentId }));
}

export class PaymentApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PaymentApiError";
  }
}

/** POST /api/payments/<op> as the caller (staff or paired station) via its bearer token. */
export async function postPayments(
  client: FilletryClient,
  op: "sale" | "abort" | "status" | "reverse" | "refund",
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<PaymentResult> {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(`/api/payments/${op}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string } & Partial<PaymentResult>;
  if (!res.ok)
    throw new PaymentApiError(json.error ?? `Payment request failed (${res.status})`, res.status);
  return json as PaymentResult;
}

export type ChargeRequest = {
  clientActionId: string;
  orderId: string;
  amount: number;
  tender: TenderType;
  terminalId?: string | null;
  tenderRef?: string | null;
  reason?: string | null;
  elevationToken?: string | null;
};
