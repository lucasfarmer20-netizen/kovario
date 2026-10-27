// The billing-* Edge Functions' core (supabase/functions/_shared/stripe-billing.ts) is pure,
// so it is tested here under Node. Secrets are generated per run; nothing real is used.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_STATUSES,
  LOOKUP_KEY_PREFIX as EDGE_PREFIX,
  PLAN_CODES as EDGE_PLAN_CODES,
  StripeError,
  formEncode,
  stripeApi,
  stripeSignature,
  subscriptionChange,
  verifyStripeSignature,
  type FetchLike,
} from "../../../supabase/functions/_shared/stripe-billing.ts";
import { ACTIVE_SUBSCRIPTION_STATUSES, LOOKUP_KEY_PREFIX, PLAN_CODES } from "./billing.ts";

describe("edge billing core matches the plan catalogue", () => {
  it("plan codes, lookup-key prefix and active statuses are identical", () => {
    expect([...EDGE_PLAN_CODES]).toEqual([...PLAN_CODES]);
    expect(EDGE_PREFIX).toBe(LOOKUP_KEY_PREFIX);
    expect([...ACTIVE_STATUSES]).toEqual([...ACTIVE_SUBSCRIPTION_STATUSES]);
  });
});

describe("Stripe webhook signature", () => {
  const secret = randomBytes(24).toString("hex");
  const payload = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated" });
  const now = 1_800_000_000;

  it("accepts a valid v1 signature (among several)", async () => {
    const sig = await stripeSignature(payload, secret, now);
    const header = `t=${now},v1=${"0".repeat(64)},v1=${sig}`;
    expect(await verifyStripeSignature(payload, header, secret, now)).toBe(true);
  });

  it("rejects a tampered body, wrong secret, missing or malformed header", async () => {
    const sig = await stripeSignature(payload, secret, now);
    const header = `t=${now},v1=${sig}`;
    expect(await verifyStripeSignature(`${payload} `, header, secret, now)).toBe(false);
    expect(await verifyStripeSignature(payload, header, `${secret}x`, now)).toBe(false);
    expect(await verifyStripeSignature(payload, null, secret, now)).toBe(false);
    expect(await verifyStripeSignature(payload, `v1=${sig}`, secret, now)).toBe(false);
    expect(await verifyStripeSignature(payload, `t=${now}`, secret, now)).toBe(false);
  });

  it("rejects replays outside the 5-minute tolerance", async () => {
    const old = now - 301;
    const header = `t=${old},v1=${await stripeSignature(payload, secret, old)}`;
    expect(await verifyStripeSignature(payload, header, secret, now)).toBe(false);
    expect(await verifyStripeSignature(payload, header, secret, old + 10)).toBe(true);
  });
});

function subEvent(over: {
  type?: string;
  status?: string;
  lookupKey?: string | null;
  metadata?: Record<string, string>;
}) {
  return {
    id: "evt_123",
    type: over.type ?? "customer.subscription.updated",
    created: 1_800_000_000,
    data: {
      object: {
        id: "sub_1",
        customer: "cus_1",
        status: over.status ?? "active",
        metadata: over.metadata ?? { org_id: "00000000-0000-4000-8000-000000000009" },
        items: {
          data: [{ price: { id: "price_1", lookup_key: over.lookupKey ?? "filletry-plant" } }],
        },
      },
    },
  };
}

describe("subscriptionChange (webhook → org.plan)", () => {
  it("grants the plan of the price's lookup key while active", () => {
    expect(subscriptionChange(subEvent({}))).toEqual({
      eventId: "evt_123",
      eventCreated: "2027-01-15T08:00:00.000Z",
      customerId: "cus_1",
      subscriptionId: "sub_1",
      status: "active",
      plan: "plant",
      orgIdHint: "00000000-0000-4000-8000-000000000009",
    });
  });

  it("keeps the plan for trialing and past_due", () => {
    expect(subscriptionChange(subEvent({ status: "trialing" }))?.plan).toBe("plant");
    expect(subscriptionChange(subEvent({ status: "past_due" }))?.plan).toBe("plant");
  });

  it("drops the plan when canceled, unpaid, incomplete or deleted", () => {
    for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]) {
      expect(subscriptionChange(subEvent({ status }))?.plan).toBeNull();
    }
    expect(
      subscriptionChange(subEvent({ type: "customer.subscription.deleted" }))?.plan,
    ).toBeNull();
  });

  it("an unknown price grants no plan", () => {
    expect(subscriptionChange(subEvent({ lookupKey: "someone-elses-price" }))?.plan).toBeNull();
  });

  it("ignores other event types and malformed events", () => {
    expect(subscriptionChange(subEvent({ type: "invoice.paid" }))).toBeNull();
    expect(subscriptionChange(null)).toBeNull();
    expect(subscriptionChange({ type: "customer.subscription.updated", data: {} })).toBeNull();
    const noCustomer = subEvent({});
    (noCustomer.data.object as { customer: unknown }).customer = null;
    expect(subscriptionChange(noCustomer)).toBeNull();
  });

  it("drops a metadata org_id that is not a uuid (it would fail the RPC forever)", () => {
    expect(
      subscriptionChange(subEvent({ metadata: { org_id: "demo-plant" } }))?.orgIdHint,
    ).toBeNull();
    expect(subscriptionChange(subEvent({ metadata: {} }))?.orgIdHint).toBeNull();
  });

  it("accepts an expanded customer object", () => {
    const e = subEvent({});
    (e.data.object as { customer: unknown }).customer = { id: "cus_9" };
    expect(subscriptionChange(e)?.customerId).toBe("cus_9");
  });
});

describe("Stripe REST requests", () => {
  type Call = { url: string; init: RequestInit };
  function fakeFetch(responses: unknown[], status = 200): { calls: Call[]; fetch: FetchLike } {
    const calls: Call[] = [];
    return {
      calls,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(responses.shift() ?? {}), { status });
      },
    };
  }
  const key = randomBytes(24).toString("hex");

  it("form-encodes nested params with bracket notation", () => {
    expect(formEncode({ a: 1, b: { c: "x y" }, d: [{ e: true }], f: undefined })).toBe(
      "a=1&b%5Bc%5D=x%20y&d%5B0%5D%5Be%5D=true",
    );
  });

  it("creates the org's customer with an org-scoped idempotency key", async () => {
    const f = fakeFetch([{ id: "cus_1" }]);
    const org = { id: "org-1", name: "Plant", slug: "plant", email: "o@x.test" };
    expect(await stripeApi(key, f.fetch).createCustomer(org)).toEqual({ id: "cus_1" });
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(f.calls[0]!.url).toBe("https://api.stripe.com/v1/customers");
    expect(headers["Idempotency-Key"]).toBe("filletry-org-customer-org-1");
    expect(headers.Authorization).toBe(`Bearer ${key}`);
    expect(String(f.calls[0]!.init.body)).toContain("metadata%5Borg_id%5D=org-1");
  });

  it("resolves a plan's price by lookup key", async () => {
    const f = fakeFetch([{ data: [{ id: "price_9" }] }, { data: [] }]);
    const api = stripeApi(key, f.fetch);
    expect(await api.priceIdFor("plant-plus")).toBe("price_9");
    expect(f.calls[0]!.init.method).toBe("GET");
    expect(f.calls[0]!.url).toContain("lookup_keys%5B0%5D=filletry-plant-plus");
    expect(await api.priceIdFor("starter")).toBeNull();
  });

  it("opens a subscription Checkout session tagged with the org", async () => {
    const f = fakeFetch([{ id: "cs_1", url: "https://checkout.stripe.test/cs_1" }]);
    const session = await stripeApi(key, f.fetch).createCheckoutSession({
      customerId: "cus_1",
      priceId: "price_1",
      orgId: "org-1",
      plan: "plant",
      successUrl: "https://app.test/admin/subscription?checkout=success",
      cancelUrl: "https://app.test/admin/subscription?checkout=cancelled",
    });
    expect(session.url).toBe("https://checkout.stripe.test/cs_1");
    const body = new URLSearchParams(String(f.calls[0]!.init.body));
    expect(body.get("mode")).toBe("subscription");
    expect(body.get("customer")).toBe("cus_1");
    expect(body.get("line_items[0][price]")).toBe("price_1");
    expect(body.get("subscription_data[metadata][org_id]")).toBe("org-1");
    expect(body.get("client_reference_id")).toBe("org-1");
  });

  it("opens a Customer Portal session", async () => {
    const f = fakeFetch([{ url: "https://billing.stripe.test/p" }]);
    const portal = await stripeApi(key, f.fetch).createPortalSession({
      customerId: "cus_1",
      returnUrl: "https://app.test/admin/subscription",
    });
    expect(portal.url).toBe("https://billing.stripe.test/p");
    expect(f.calls[0]!.url).toBe("https://api.stripe.com/v1/billing_portal/sessions");
  });

  it("surfaces Stripe errors with status and code, never the key", async () => {
    const f = fakeFetch(
      [{ error: { code: "resource_missing", message: "No such customer" } }],
      404,
    );
    const err = await stripeApi(key, f.fetch)
      .createPortalSession({ customerId: "cus_x", returnUrl: "https://app.test" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StripeError);
    expect(err).toMatchObject({ status: 404, code: "resource_missing" });
    expect(String((err as Error).message)).not.toContain(key);
  });
});
