// WP-18 end to end against the local Supabase: the register's route flow (WP-16 service) with the
// real stripe_terminal adapter talking to the in-memory Stripe mock (docs/05 §6). Covers the
// PaymentIntent metadata {org_id, payment_id}, card meta stored on the payment, an indeterminate
// sale whose immediate status check asks about the sale's own PaymentIntent, and the webhook
// settling that indeterminate payment (and only that). The test client cannot write Vault, so the
// restricted key and the signing secret are injected here; their Vault lookups are covered by
// supabase/tests/18_stripe_terminal.test.sql and 16_register (VAULT).
import type { Json } from "db";
import {
  createStripeTerminalProvider,
  manualProvider,
  stripeWebhookSignature,
  type PaymentProvider,
  type ProviderKind,
} from "payments";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOrg,
  createUser,
  dropOrg,
  serviceRoleClient,
  type TestOrg,
  type TestUser,
} from "../../../../packages/db/src/testing/local-supabase";
import { StripeMock } from "../../../../packages/payments/test/stripe-mock";
import { chargePayment, reversePayment, type PaymentsDeps } from "./service";
import { reconcileStripeWebhook } from "./stripe";

type Payment = { id: string; state: string; amount: number; provider_ref: string };
type Order = { id: string; state: string; totals: { due: number } };
type Result = { status: string; payment: Payment; order: Order | null };

const KEY = `rk_test_${randomBytes(12).toString("hex")}`;
const WHSEC = `whsec_${randomBytes(12).toString("hex")}`;
const admin = serviceRoleClient();
const cid = (p: string) => `${p}-${randomUUID()}`;
const res = (j: Json) => j as unknown as Result;

/** The real adapter with the key Vault would supply (see the header). */
function withKey(p: PaymentProvider): PaymentProvider {
  const t = <R extends { terminal: object }>(r: R) => ({
    ...r,
    terminal: { ...r.terminal, secret: KEY },
  });
  return {
    kind: p.kind,
    sale: (r) => p.sale(t(r)),
    abort: (r) => p.abort(t(r)),
    status: (r) => p.status(t(r)),
    reverse: (r) => p.reverse(t(r)),
    refund: (r) => p.refund(t(r)),
    scrub: (x) => p.scrub(x),
  };
}

describe(
  "Stripe Terminal through the register (local DB + Stripe mock)",
  { timeout: 60_000 },
  () => {
    let org: TestOrg;
    let cashier: TestUser;
    let manager: TestUser;
    let customerId = "";
    let terminalId = "";
    let mock: StripeMock;
    let clock = 0;
    let onSleep: ((t: number) => void) | null = null;

    const stripe = () =>
      withKey(
        createStripeTerminalProvider({
          fetch: mock.fetch,
          now: () => clock,
          sleep: (ms) => {
            clock += ms;
            onSleep?.(clock);
            return Promise.resolve();
          },
        }),
      );
    const deps = (user: TestUser = cashier): PaymentsDeps => ({
      caller: user.client,
      service: admin,
      providerFor: (kind: ProviderKind) => (kind === "manual" ? manualProvider : stripe()),
      timeoutMs: 120_000,
    });

    async function cart(amount: number): Promise<string> {
      await admin
        .from("charge")
        .update({ state: "voided" })
        .eq("customer_id", customerId)
        .eq("state", "open");
      const { error } = await admin.from("charge").insert({
        org_id: org.id,
        number: `CHG-${Math.floor(Math.random() * 9e6) + 1e6}`,
        customer_id: customerId,
        kind: "adjustment",
        source_type: "manual",
        qty: 1,
        unit: "each",
        unit_price: amount,
      });
      if (error) throw error;
      const { data, error: loadError } = await cashier.client.rpc("register_load_outstanding", {
        p_client_action_id: cid("load"),
        p_customer_id: customerId,
      });
      if (loadError) throw loadError;
      return (data as unknown as Order).id;
    }

    async function paymentRow(id: string) {
      const { data, error } = await admin
        .from("payment")
        .select("state, provider_txn, card_brand, card_last4, entry_mode, auth_code, amount")
        .eq("id", id)
        .single();
      if (error) throw error;
      return data;
    }

    async function signed(event: object) {
      const payload = JSON.stringify(event);
      const t = Math.floor(Date.now() / 1000);
      return { payload, signature: `t=${t},v1=${await stripeWebhookSignature(payload, WHSEC, t)}` };
    }

    const webhookDeps = () => ({
      service: admin,
      providerFor: () => stripe(),
      webhookSecret: () => Promise.resolve({ org_id: org.id, secret: WHSEC }),
    });

    beforeAll(async () => {
      org = await createOrg();
      const { error: settingsError } = await admin
        .from("org")
        .update({ settings: { tax: { mode: "none" } } })
        .eq("id", org.id);
      if (settingsError) throw settingsError;
      cashier = await createUser(org, "cashier");
      manager = await createUser(org, "manager");
      const { data: c, error } = await admin
        .from("customer")
        .insert({ org_id: org.id, name: "Stripe Sue", phone: "+19075551718" })
        .select("id")
        .single();
      if (error) throw error;
      customerId = c.id;
      const { data: t, error: tErr } = await admin
        .from("payment_terminal")
        .insert({
          org_id: org.id,
          name: "Front reader",
          provider: "stripe_terminal",
          config: { stripe_reader_id: "tmr_A", stripe_location_id: "tml_L" },
        })
        .select("id")
        .single();
      if (tErr) throw tErr;
      terminalId = t.id;
    });

    afterAll(async () => {
      if (org) await dropOrg(org);
    });

    it("approved: the PaymentIntent carries {org_id, payment_id}; card meta is stored; the cart is paid", async () => {
      mock = new StripeMock(KEY, ["tmr_A"]);
      clock = 0;
      const orderId = await cart(25);
      const r = res(
        await chargePayment(deps(), {
          clientActionId: cid("sale"),
          orderId,
          amount: 25,
          terminalId,
          tender: "card",
        }),
      );
      expect(r.payment.state).toBe("approved");
      expect(r.order?.state).toBe("paid");
      const row = await paymentRow(r.payment.id);
      expect(row).toMatchObject({
        state: "approved",
        card_brand: "VISA",
        card_last4: "4242",
        entry_mode: "chip",
        auth_code: "123456",
      });
      expect(row.provider_txn).toMatch(/^pi_/);
      expect(mock.intent(row.provider_txn!).metadata).toEqual({
        org_id: org.id,
        payment_id: r.payment.id,
        provider_ref: r.payment.provider_ref,
      });
      const { data: events } = await admin
        .from("payment_event")
        .select("payload")
        .eq("payment_id", r.payment.id);
      expect(JSON.stringify(events)).not.toContain(KEY);
    });

    it("Stripe lost mid-sale → indeterminate (blocks retry) → the webhook asks Stripe and settles it", async () => {
      mock = new StripeMock(KEY, ["tmr_A"]);
      mock.script({ action: "hold" });
      clock = 0;
      onSleep = (t) => {
        if (t === 2_000) mock.outage(true);
      };
      const orderId = await cart(40);
      const r = res(
        await chargePayment(deps(), {
          clientActionId: cid("sale"),
          orderId,
          amount: 40,
          terminalId,
          tender: "card",
        }),
      );
      onSleep = null;
      mock.outage(false);
      expect(r.payment.state).toBe("indeterminate");
      const row = await paymentRow(r.payment.id);
      const piId = row.provider_txn!;
      expect(piId).toMatch(/^pi_/);

      // indeterminate blocks a second Charge (never charge twice)
      const retry = await chargePayment(deps(), {
        clientActionId: cid("sale"),
        orderId,
        amount: 40,
        terminalId,
        tender: "card",
      }).catch((e: unknown) => e);
      expect(retry).toMatchObject({ status: 409 });

      // the customer had paid on the reader; Stripe's event settles the payment
      mock.finish("tmr_A", "approve");
      const event = {
        id: "evt_1",
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: piId,
            object: "payment_intent",
            metadata: { org_id: org.id, payment_id: r.payment.id },
          },
        },
      };
      const out = await reconcileStripeWebhook(webhookDeps(), {
        terminalId,
        ...(await signed(event)),
      });
      expect(out).toEqual({ status: "reconciled", outcome: "approved", recorded: "applied" });
      expect(await paymentRow(r.payment.id)).toMatchObject({
        state: "approved",
        card_last4: "4242",
      });
      const { data: order } = await cashier.client.rpc("register_order", { p_order_id: orderId });
      expect((order as unknown as Order).state).toBe("paid");

      // the same event again: the payment is no longer indeterminate — ignored
      const again = await reconcileStripeWebhook(webhookDeps(), {
        terminalId,
        ...(await signed(event)),
      });
      expect(again.status).toBe("ignored");
    });

    it("a refund still pending at Stripe stays unresolved; when Stripe fails it, nothing was refunded", async () => {
      mock = new StripeMock(KEY, ["tmr_A"]);
      clock = 0;
      const orderId = await cart(30);
      const paid = res(
        await chargePayment(deps(), {
          clientActionId: cid("sale"),
          orderId,
          amount: 30,
          terminalId,
          tender: "card",
        }),
      );
      expect(paid.payment.state).toBe("approved");
      const piId = (await paymentRow(paid.payment.id)).provider_txn!;

      mock.refundStatus = "pending";
      const refund = () =>
        reversePayment(deps(manager), {
          clientActionId: cid("rf"),
          paymentId: paid.payment.id,
          kind: "refund",
          amount: 30,
          reason: "customer changed their mind",
        });
      const first = (await refund()) as unknown as {
        status: string;
        payment: Payment & { reverse_unresolved: boolean; refundable: number };
      };
      // pending is not money returned: the payment stays approved, the reversal unresolved
      expect(first.status).toBe("indeterminate");
      expect(first.payment).toMatchObject({ state: "approved", reverse_unresolved: true });
      const { data: alerts } = await admin
        .from("domain_event")
        .select("payload")
        .eq("subject_id", paid.payment.id)
        .eq("kind", "payment_alert");
      expect(JSON.stringify(alerts)).toContain("reversal_unresolved");
      // and blocks another void / refund until a manager confirms the outcome
      await expect(refund()).rejects.toMatchObject({ status: 409 });
      expect(mock.callsTo("POST /v1/refunds")).toHaveLength(1);

      // Stripe fails the pending refund (insufficient balance): the money never went back
      const [refundId] = [...mock.refunds.keys()];
      mock.settleRefund(refundId!, "failed");
      expect(mock.intent(piId).refunded).toBe(0);

      // the manager checks Stripe and records that it was not reversed
      const { data, error } = await manager.client.rpc("payment_reverse_resolve", {
        p_client_action_id: cid("rr"),
        p_payment_id: paid.payment.id,
        p_outcome: "not_reversed",
        p_reason: "Stripe shows the refund failed",
      });
      expect(error).toBeNull();
      expect(
        (data as unknown as { payment: Payment & { refundable: number } }).payment,
      ).toMatchObject({ state: "approved", refundable: 30 });
      const { data: refundOrders } = await admin
        .from("register_order")
        .select("id")
        .eq("refund_payment_id", paid.payment.id);
      expect(refundOrders).toEqual([]);

      // a later refund that succeeds settles normally
      mock.refundStatus = "succeeded";
      const second = (await refund()) as unknown as { payment: Payment };
      expect(second.payment.state).toBe("refunded");
    });
  },
);
