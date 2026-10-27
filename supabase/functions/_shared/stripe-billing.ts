// Stripe Billing core for the billing-* Edge Functions (docs/07-INTEGRATIONS.md §5: tenant
// subscriptions — Checkout + Customer Portal, webhook updates org.plan).
// Pure: fetch + WebCrypto only, no Deno globals and no Stripe SDK, so
// packages/payments/src/stripe-billing.test.ts exercises it under Node. The edge runtime
// cannot import packages/, so the plan codes and lookup-key scheme are restated here and a
// parity test pins them to packages/payments/src/billing.ts.
// Never log request bodies or headers from this module: they carry the secret key.

export const PLAN_CODES = ["starter", "plant", "plant-plus", "multi-site", "enterprise"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export const LOOKUP_KEY_PREFIX = "filletry-";

export function isPlanCode(value: unknown): value is PlanCode {
  return typeof value === "string" && (PLAN_CODES as readonly string[]).includes(value);
}

export function lookupKey(plan: PlanCode): string {
  return `${LOOKUP_KEY_PREFIX}${plan}`;
}

export function planFromLookupKey(key: unknown): PlanCode | null {
  if (typeof key !== "string" || !key.startsWith(LOOKUP_KEY_PREFIX)) return null;
  const code = key.slice(LOOKUP_KEY_PREFIX.length);
  return isPlanCode(code) ? code : null;
}

/** Statuses that keep the plan (past_due: Stripe is still retrying the invoice). */
export const ACTIVE_STATUSES: readonly string[] = ["active", "trialing", "past_due"];

// Stripe REST ---------------------------------------------------------------------------

type Params = { [key: string]: string | number | boolean | null | undefined | Params | Params[] };

/** application/x-www-form-urlencoded with Stripe's bracket notation for nesting. */
export function formEncode(params: Params, prefix = ""): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      v.forEach((item, i) => parts.push(formEncode(item, `${key}[${i}]`)));
    } else if (typeof v === "object") {
      parts.push(formEncode(v, key));
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.filter(Boolean).join("&");
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

const API = "https://api.stripe.com";

export function stripeApi(secretKey: string, fetchImpl: FetchLike = fetch) {
  async function call<T>(
    method: "GET" | "POST",
    path: string,
    params: Params = {},
    idempotencyKey?: string,
  ): Promise<T> {
    const body = formEncode(params);
    const headers: Record<string, string> = { Authorization: `Bearer ${secretKey}` };
    if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const url = method === "GET" && body ? `${API}${path}?${body}` : `${API}${path}`;
    const res = await fetchImpl(url, { method, headers, body: method === "POST" ? body : undefined });
    const json = (await res.json().catch(() => null)) as
      | (T & { error?: { code?: string; message?: string } })
      | null;
    if (!res.ok || !json) {
      // Stripe's error message never echoes the key; the status and code are enough to debug.
      throw new StripeError(res.status, json?.error?.code ?? null, json?.error?.message ?? "stripe_error");
    }
    return json;
  }

  return {
    /** One Stripe customer per org: the idempotency key makes a retried create return it. */
    createCustomer(org: { id: string; name: string; slug: string; email: string | null }) {
      return call<{ id: string }>(
        "POST",
        "/v1/customers",
        { name: org.name, email: org.email ?? undefined, metadata: { org_id: org.id, org_slug: org.slug } },
        `filletry-org-customer-${org.id}`,
      );
    },

    async priceIdFor(plan: PlanCode): Promise<string | null> {
      const list = await call<{ data: { id: string }[] }>("GET", "/v1/prices", {
        "lookup_keys[0]": lookupKey(plan),
        active: true,
        limit: 1,
      });
      return list.data[0]?.id ?? null;
    },

    createCheckoutSession(input: {
      customerId: string;
      priceId: string;
      orgId: string;
      plan: PlanCode;
      successUrl: string;
      cancelUrl: string;
    }) {
      return call<{ id: string; url: string }>("POST", "/v1/checkout/sessions", {
        mode: "subscription",
        customer: input.customerId,
        client_reference_id: input.orgId,
        line_items: [{ price: input.priceId, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata: { org_id: input.orgId, plan: input.plan },
        subscription_data: { metadata: { org_id: input.orgId } },
      });
    },

    createPortalSession(input: { customerId: string; returnUrl: string }) {
      return call<{ url: string }>("POST", "/v1/billing_portal/sessions", {
        customer: input.customerId,
        return_url: input.returnUrl,
      });
    },
  };
}

// Webhook --------------------------------------------------------------------------------

const encoder = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function stripeSignature(payload: string, secret: string, timestamp: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${payload}`)));
}

/**
 * Verifies a `Stripe-Signature` header (`t=<unix>,v1=<hex>[,v1=…]`) over the raw body,
 * rejecting timestamps outside `toleranceSeconds` (replay protection).
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!header) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === "t" && v && /^\d+$/.test(v)) timestamp = Number(v);
    if (k === "v1" && v) signatures.push(v);
  }
  if (timestamp === null || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = await stripeSignature(payload, secret, timestamp);
  return signatures.some((s) => timingSafeEqual(s, expected));
}

export const SUBSCRIPTION_EVENTS = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
] as const;

export interface SubscriptionChange {
  eventId: string;
  /** ISO time the event was created at Stripe; orders out-of-order deliveries. */
  eventCreated: string;
  customerId: string;
  subscriptionId: string;
  status: string;
  /** The plan to grant, or null when the subscription no longer entitles one. */
  plan: PlanCode | null;
  orgIdHint: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown): string | null => (typeof v === "string" && UUID.test(v) ? v : null);

/** The org-plan change a webhook event implies, or null for events we ignore. */
export function subscriptionChange(event: unknown): SubscriptionChange | null {
  if (!isObj(event) || !(SUBSCRIPTION_EVENTS as readonly unknown[]).includes(event.type)) return null;
  const sub = isObj(event.data) && isObj(event.data.object) ? event.data.object : null;
  const eventId = str(event.id);
  const created = typeof event.created === "number" ? event.created : null;
  if (!sub || !eventId || created === null) return null;
  const subscriptionId = str(sub.id);
  const customerId = str(sub.customer) ?? (isObj(sub.customer) ? str(sub.customer.id) : null);
  const status = str(sub.status);
  if (!subscriptionId || !customerId || !status) return null;

  const items = isObj(sub.items) && Array.isArray(sub.items.data) ? sub.items.data : [];
  const first: unknown = items[0];
  const price = isObj(first) && isObj(first.price) ? first.price : null;
  const entitled = event.type !== "customer.subscription.deleted" && ACTIVE_STATUSES.includes(status);

  return {
    eventId,
    eventCreated: new Date(created * 1000).toISOString(),
    customerId,
    subscriptionId,
    status,
    plan: entitled ? planFromLookupKey(price?.lookup_key) : null,
    orgIdHint: isObj(sub.metadata) ? uuid(sub.metadata.org_id) : null,
  };
}
