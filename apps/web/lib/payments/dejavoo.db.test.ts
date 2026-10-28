// WP-17: the register's payment flow (docs/05 §2) with the REAL dejavoo_spin adapter talking
// HTTP to the fake SPIn server (docs/05 §6), against the local Supabase. The terminal's config
// (endpoint, TPN) comes from payment_terminal through payment_terminal_runtime like production;
// only the Authkey is handed to the adapter by the test (the JS fixtures cannot write Vault —
// the Vault path itself is covered by 16_register `VAULT —`).
import {
  createDejavooProvider,
  manualProvider,
  type PaymentProvider,
  type ProviderKind,
  type TerminalConfig,
} from "payments";
import type { Json } from "db";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createOrg,
  createUser,
  dropOrg,
  serviceRoleClient,
  type TestOrg,
  type TestUser,
} from "../../../../packages/db/src/testing/local-supabase";
import { FakeSpinServer } from "../../../../packages/payments/test/fake-spin-server";
import {
  abortPayment,
  chargePayment,
  checkPaymentStatus,
  reversePayment,
  type PaymentsDeps,
} from "./service";

type Payment = { id: string; state: string; amount: number; attempt: number; provider_ref: string };
type Order = { id: string; state: string; totals: { due: number; paid: number } };
type Result = { status: string; payment: Payment; order: Order | null };

const admin = serviceRoleClient();
const cid = (p: string) => `${p}-${randomUUID()}`;
const res = (j: Json) => j as unknown as Result;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The Dejavoo adapter with the fake server's Authkey in place of the Vault secret. */
function withAuthkey(p: PaymentProvider, authkey: string): PaymentProvider {
  const t = (terminal: TerminalConfig): TerminalConfig => ({ ...terminal, secret: authkey });
  return {
    kind: p.kind,
    sale: (r) => p.sale({ ...r, terminal: t(r.terminal) }),
    abort: (r) => p.abort({ ...r, terminal: t(r.terminal) }),
    status: (r) => p.status({ ...r, terminal: t(r.terminal) }),
    reverse: (r) => p.reverse({ ...r, terminal: t(r.terminal) }),
    refund: (r) => p.refund({ ...r, terminal: t(r.terminal) }),
    scrub: (x) => p.scrub(x),
  };
}

describe(
  "register flow with the dejavoo_spin adapter (fake SPIn server)",
  { timeout: 60_000 },
  () => {
    let org: TestOrg;
    let cashier: TestUser;
    let manager: TestUser;
    let customerId = "";
    let terminalId = "";
    let spin: FakeSpinServer;
    let dejavoo: PaymentProvider;

    const deps = (user: TestUser = cashier): PaymentsDeps => ({
      caller: user.client,
      service: admin,
      providerFor: (kind: ProviderKind) => (kind === "manual" ? manualProvider : dejavoo),
      timeoutMs: 1000, // SPInProxyTimeout 1 s; HTTP timeout 1 s + 150 ms buffer
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

    const charge = (orderId: string, amount: number) =>
      chargePayment(deps(), {
        clientActionId: cid("sale"),
        orderId,
        amount,
        terminalId,
        tender: "card",
      }).then(res);

    async function paymentRow(id: string) {
      const { data, error } = await admin
        .from("payment")
        .select("state, amount, provider_ref, provider_txn, card_brand, card_last4, auth_code")
        .eq("id", id)
        .single();
      if (error) throw error;
      return data;
    }

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
        .insert({ org_id: org.id, name: "Spin Sam", phone: "+19075551677" })
        .select("id")
        .single();
      if (error) throw error;
      customerId = c.id;
    });

    beforeEach(async () => {
      spin = await FakeSpinServer.start();
      dejavoo = withAuthkey(createDejavooProvider({ transportBufferMs: 150 }), spin.opts.authkey);
      const { data: t, error } = await admin
        .from("payment_terminal")
        .insert({
          org_id: org.id,
          name: `Dejavoo ${randomUUID().slice(0, 8)}`,
          provider: "dejavoo_spin",
          config: { endpoint_url: spin.url, tpn: spin.opts.tpn },
        })
        .select("id")
        .single();
      if (error) throw error;
      terminalId = t.id;
    });

    afterEach(async () => {
      await spin.close();
    });

    afterAll(async () => {
      if (org) await dropOrg(org);
    });

    it("approved: the payment's ref is the Sale's ReferenceId; card meta stored; no Authkey in any event", async () => {
      const orderId = await cart(25);
      const r = await charge(orderId, 25);
      expect(r.payment.state).toBe("approved");
      expect(r.order?.state).toBe("paid");
      const [sale] = spin.requestsOf("Sale");
      expect(sale).toMatchObject({ ReferenceId: r.payment.provider_ref, Amount: 25 });
      expect(sale).not.toHaveProperty("RegisterId");
      expect(await paymentRow(r.payment.id)).toMatchObject({
        provider_txn: "1001",
        card_brand: "VISA",
        card_last4: "4242",
        auth_code: "A1B2C3",
      });
      const { data: events } = await admin
        .from("payment_event")
        .select("payload")
        .eq("payment_id", r.payment.id);
      expect(JSON.stringify(events)).not.toContain(spin.opts.authkey);
    });

    it("issuer decline as 1012 → declined (not cancelled); the retry is attempt 2 with a new ref", async () => {
      spin.queue("Sale", {
        statusCode: "1012",
        hostResponseCode: "51",
        hostResponseMessage: "NSF",
      });
      const orderId = await cart(12);
      const declined = await charge(orderId, 12);
      expect(declined.payment).toMatchObject({ state: "declined", attempt: 1 });
      const retry = await charge(orderId, 12);
      expect(retry.payment).toMatchObject({ state: "approved", attempt: 2 });
      expect(spin.requestsOf("Sale").map((b) => b.ReferenceId)).toEqual([
        declined.payment.provider_ref,
        retry.payment.provider_ref,
      ]);
      expect(spin.charges).toBe(1);
    });

    it("timeout → status approved: indeterminate blocks a second Charge; Check status records the approval", async () => {
      spin.queue("Sale", { delayMs: 1600 });
      const orderId = await cart(30);
      const first = await charge(orderId, 30);
      expect(first.payment.state).toBe("indeterminate");
      expect(spin.requestsOf("Status")).toHaveLength(1); // asked at once (docs/05 §2.4)
      await expect(charge(orderId, 30)).rejects.toMatchObject({ status: 409 });
      expect(spin.requestsOf("Sale")).toHaveLength(1); // never charged twice
      while (!spin.txns.has(first.payment.provider_ref)) await sleep(20);
      const resolved = res(await checkPaymentStatus(deps(), { paymentId: first.payment.id }));
      expect(resolved.payment.state).toBe("approved");
      expect(resolved.order?.state).toBe("paid");
    });

    it("timeout → status cancelled: the line stays open for a retry", async () => {
      spin.queue("Sale", { statusCode: "2007" }).queue("Status", { statusCode: "1012" });
      const orderId = await cart(8);
      const r = await charge(orderId, 8);
      expect(r.payment.state).toBe("cancelled");
      expect(r.order?.state).toBe("open");
    });

    it("cashier Cancel: abort reaches the terminal while the Sale waits; the Sale records cancelled", async () => {
      spin.queue("Sale", { hold: true });
      const orderId = await cart(9);
      const pending = chargePayment(
        { ...deps(), timeoutMs: 5000 },
        { clientActionId: cid("sale"), orderId, amount: 9, terminalId, tender: "card" },
      );
      let paymentId = "";
      while (!paymentId) {
        const { data } = await admin
          .from("payment")
          .select("id")
          .eq("register_order_id", orderId)
          .eq("state", "pending")
          .maybeSingle();
        if (data && spin.requestsOf("Sale").length > 0) paymentId = data.id;
        else await sleep(25);
      }
      expect(res(await abortPayment(deps(), { paymentId })).status).toBe("abort_sent");
      expect(res(await pending).payment.state).toBe("cancelled");
    });

    it("config error (2003) and connection refused are plain errors: the cashier may retry", async () => {
      await admin
        .from("payment_terminal")
        .update({ config: { endpoint_url: spin.url, tpn: spin.opts.tpn, register_id: "nope" } })
        .eq("id", terminalId);
      const orderId = await cart(7);
      expect((await charge(orderId, 7)).payment.state).toBe("error");
      const gone = await FakeSpinServer.start();
      await gone.close(); // a port nothing listens on: refused before anything is sent
      await admin
        .from("payment_terminal")
        .update({ config: { endpoint_url: gone.url, tpn: spin.opts.tpn } })
        .eq("id", terminalId);
      expect((await charge(orderId, 7)).payment.state).toBe("error");
      expect(spin.charges).toBe(0);
    });

    it("manager void → /Void with the original ref; ProcessedAs Return records refunded", async () => {
      const orderId = await cart(20);
      const paid = await charge(orderId, 20);
      expect(paid.payment.state).toBe("approved");
      spin.queue("Void", { processedAs: "Return" });
      await reversePayment(deps(manager), {
        clientActionId: cid("void"),
        paymentId: paid.payment.id,
        kind: "reverse",
        reason: "wrong customer",
      });
      expect(spin.requestsOf("Void")[0]).toMatchObject({
        OriginalReferenceId: paid.payment.provider_ref,
        OriginalTransNum: "1001",
        Amount: 20,
      });
      expect((await paymentRow(paid.payment.id)).state).toBe("refunded");
    });

    it("manager void before the batch → voided", async () => {
      const orderId = await cart(21);
      const paid = await charge(orderId, 21);
      await reversePayment(deps(manager), {
        clientActionId: cid("void"),
        paymentId: paid.payment.id,
        kind: "reverse",
        reason: "double ring",
      });
      expect((await paymentRow(paid.payment.id)).state).toBe("voided");
    });
  },
);
