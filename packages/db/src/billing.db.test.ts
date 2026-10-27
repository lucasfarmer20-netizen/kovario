// WP-22 Stripe Billing Edge Functions as served by `supabase start`: who may open Checkout or
// the Customer Portal, and the webhook refusing anything not signed by Stripe. Signature
// verification and event mapping are unit-tested in packages/payments
// (stripe-billing.test.ts); org.plan writes in supabase/tests/22_onboarding_billing.test.sql.
// No Stripe account is needed: without STRIPE_* secrets the functions answer 503.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOrg,
  createUser,
  dropOrg,
  localSupabase,
  serviceRoleClient,
  type TestOrg,
  type TestUser,
} from "./testing/local-supabase";

async function call(
  fn: string,
  body: unknown,
  token?: string,
  headers: Record<string, string> = {},
) {
  const s = localSupabase();
  const res = await fetch(`${s.API_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: s.ANON_KEY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as { error?: string } };
}

async function token(user: TestUser): Promise<string> {
  const { data } = await user.client.auth.getSession();
  if (!data.session) throw new Error("no session");
  return data.session.access_token;
}

// The first Edge Function call on a fresh `supabase start` (CI) fetches its npm imports.
describe("billing Edge Functions", { timeout: 60_000 }, () => {
  let org: TestOrg;
  let owner: TestUser;
  let manager: TestUser;
  const returnUrl = "http://127.0.0.1:3000/admin/subscription";

  beforeAll(async () => {
    org = await createOrg();
    owner = await createUser(org, "owner");
    manager = await createUser(org, "manager");
  });

  afterAll(async () => {
    await dropOrg(org);
  });

  it("checkout and portal require a signed-in owner", async () => {
    for (const fn of ["billing-checkout", "billing-portal"]) {
      expect((await call(fn, { plan: "plant", return_url: returnUrl })).status).toBe(401);
      expect(
        (await call(fn, { plan: "plant", return_url: returnUrl }, await token(manager))).status,
      ).toBe(403);
    }
  });

  it("checkout rejects an unknown plan or a non-http return url before touching Stripe", async () => {
    const t = await token(owner);
    expect(
      (await call("billing-checkout", { plan: "gold", return_url: returnUrl }, t)).body,
    ).toEqual({
      error: "invalid_input",
    });
    expect(
      (await call("billing-checkout", { plan: "plant", return_url: "javascript:alert(1)" }, t))
        .status,
    ).toBe(400);
    expect((await call("billing-portal", { return_url: "ftp://x" }, t)).status).toBe(400);
  });

  it("the webhook refuses unsigned or forged events and leaves org.plan alone", async () => {
    const forged = JSON.stringify({
      id: "evt_forged",
      type: "customer.subscription.created",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "sub_forged",
          customer: "cus_forged",
          status: "active",
          metadata: { org_id: org.id },
          items: { data: [{ price: { lookup_key: "filletry-enterprise" } }] },
        },
      },
    });
    const unsigned = await call("billing-webhook", forged);
    const badSig = await call("billing-webhook", forged, undefined, {
      "Stripe-Signature": `t=${Math.floor(Date.now() / 1000)},v1=${"ab".repeat(32)}`,
    });
    // 400 invalid_signature when STRIPE_WEBHOOK_SECRET is set, 503 when it is not.
    for (const r of [unsigned, badSig]) {
      expect([400, 503]).toContain(r.status);
      expect(["invalid_signature", "billing_not_configured"]).toContain(r.body?.error);
    }
    const { data } = await serviceRoleClient()
      .from("org")
      .select("plan, stripe_customer_id")
      .eq("id", org.id)
      .single();
    expect(data).toEqual({ plan: null, stripe_customer_id: null });
  });
});
