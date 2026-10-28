// Stripe Terminal server endpoints (docs/05 §5) with stubbed Supabase clients and the in-memory
// Stripe mock: connection tokens (who may get one; the key never leaves the server) and the
// webhook (signature, indeterminate only, Stripe re-asked). The real-DB flow is
// stripe.db.test.ts.
import type { FilletryClient, Json } from "db";
import { createStripeTerminalProvider, stripeWebhookSignature } from "payments";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import * as tokenRoute from "@/app/api/payments/stripe/connection-token/route";
import * as webhookRoute from "@/app/api/payments/stripe/webhook/[terminalId]/route";
import { StripeMock } from "../../../../packages/payments/test/stripe-mock";
import { stripeWebhookRoute } from "./http";
import { PaymentRequestError } from "./service";
import { reconcileStripeWebhook, stripeConnectionTokenFor, type StripeWebhookDeps } from "./stripe";

const KEY = `rk_test_${randomBytes(12).toString("hex")}`;
const WHSEC = `whsec_${randomBytes(12).toString("hex")}`;
const ORG = "0a000000-0000-4000-8000-000000000001";
const TERMINAL = "0a000000-0000-4000-8000-000000000071";
const PAYMENT = "0a000000-0000-4000-8000-0000000000aa";
const NOW = 1_800_000_000;

type Rpc = Record<string, (args: Record<string, unknown>) => unknown>;
type Calls = { rpc: { name: string; args: Record<string, unknown> }[] };

function client(opts: {
  role?: string | null;
  terminal?: Record<string, unknown> | null;
  rpc?: Rpc;
  calls?: Calls;
}): FilletryClient {
  return {
    auth: {
      getClaims: () =>
        Promise.resolve({
          data: opts.role ? { claims: { sub: "u-1", org_id: ORG, app_role: opts.role } } : null,
          error: null,
        }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: opts.terminal ?? null, error: null }),
        }),
      }),
    }),
    rpc: (name: string, args: Record<string, unknown>) => {
      opts.calls?.rpc.push({ name, args });
      const f = opts.rpc?.[name];
      return Promise.resolve(
        f
          ? { data: f(args), error: null }
          : { data: null, error: { message: "not found", code: "P0002" } },
      );
    },
  } as unknown as FilletryClient;
}

const runtime = {
  config: { stripe_reader_id: "tmr_A", stripe_location_id: "tml_L" },
  secret: KEY,
};

let mock: StripeMock;
beforeEach(() => {
  mock = new StripeMock(KEY, ["tmr_A"]);
});

describe("route config", () => {
  it.each([
    ["connection-token", tokenRoute],
    ["webhook", webhookRoute],
  ])("%s runs on the Node runtime", (_n, route) => {
    expect(route.runtime).toBe("nodejs");
    expect(typeof route.POST).toBe("function");
  });
});

describe("connection token (docs/05 §5)", () => {
  const stripeTerminal = {
    id: TERMINAL,
    org_id: ORG,
    provider: "stripe_terminal",
    is_active: true,
  };
  const deps = (
    role: string | null,
    terminal: Record<string, unknown> | null = stripeTerminal,
  ) => ({
    caller: client({ role, terminal }),
    service: client({ rpc: { payment_terminal_runtime: () => runtime } }),
    providerFor: () => {
      throw new Error("unused");
    },
    stripe: { fetch: mock.fetch },
  });

  it("register staff get a token scoped to the terminal's location; the key never leaves the server", async () => {
    for (const role of ["cashier", "station", "manager"]) {
      const out = (await stripeConnectionTokenFor(deps(role), { terminalId: TERMINAL })) as {
        secret: string;
        location: string;
      };
      expect(out.secret).toMatch(/^pst_test_/);
      expect(out.location).toBe("tml_L");
      expect(JSON.stringify(out)).not.toContain(KEY);
    }
  });

  it.each([
    ["the print agent", "agent", stripeTerminal, 403],
    ["no org session", null, stripeTerminal, 403],
    ["a terminal the caller cannot see (other org)", "cashier", null, 404],
    ["a Dejavoo terminal", "cashier", { ...stripeTerminal, provider: "dejavoo_spin" }, 400],
    ["an inactive terminal", "cashier", { ...stripeTerminal, is_active: false }, 409],
  ])("refuses %s", async (_l, role, terminal, status) => {
    await expect(
      stripeConnectionTokenFor(deps(role, terminal), { terminalId: TERMINAL }),
    ).rejects.toMatchObject({ status });
    expect(mock.calls).toHaveLength(0);
  });

  it("a key Stripe refuses is a 502 without the key", async () => {
    const d = deps("cashier");
    d.service = client({
      rpc: {
        payment_terminal_runtime: () => ({
          ...runtime,
          secret: `rk_test_${randomBytes(6).toString("hex")}`,
        }),
      },
    });
    const err = await stripeConnectionTokenFor(d, { terminalId: TERMINAL }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PaymentRequestError);
    expect((err as PaymentRequestError).status).toBe(502);
    expect((err as Error).message).not.toContain(KEY);
  });
});

describe("webhook reconciles indeterminate only (docs/05 §5)", () => {
  let calls: Calls;
  let payment: Record<string, unknown>;
  let recorded: Json | null;

  function webhookDeps(): StripeWebhookDeps {
    return {
      service: client({
        calls,
        rpc: {
          payment_for_webhook: () => payment,
          payment_terminal_runtime: () => runtime,
          payment_record_result: (args) => {
            recorded = args.p_result as Json;
            return { status: "applied" };
          },
        },
      }),
      providerFor: () => createStripeTerminalProvider({ fetch: mock.fetch }),
      webhookSecret: () => Promise.resolve({ org_id: ORG, secret: WHSEC }),
      nowSeconds: () => NOW,
    };
  }

  async function signed(event: object) {
    const payload = JSON.stringify(event);
    const sig = await stripeWebhookSignature(payload, WHSEC, NOW);
    return { payload, signature: `t=${NOW},v1=${sig}` };
  }

  const event = (
    piId: string,
    meta: Record<string, string> = { org_id: ORG, payment_id: PAYMENT },
  ) => ({
    id: "evt_1",
    type: "payment_intent.succeeded",
    data: { object: { id: piId, object: "payment_intent", metadata: meta } },
  });

  beforeEach(() => {
    calls = { rpc: [] };
    recorded = null;
    const pi = mock.seedIntent({
      amount: 2500,
      status: "succeeded",
      metadata: { provider_ref: "ref-1" },
    });
    payment = {
      id: PAYMENT,
      org_id: ORG,
      state: "indeterminate",
      provider: "stripe_terminal",
      terminal_id: TERMINAL,
      amount: 25,
      provider_ref: "ref-1",
      provider_txn: pi.id,
      tender: "card",
    };
  });

  it("an indeterminate payment is settled by asking Stripe, recorded as a status check", async () => {
    const r = await reconcileStripeWebhook(webhookDeps(), {
      terminalId: TERMINAL,
      ...(await signed(event(String(payment.provider_txn)))),
    });
    expect(r).toEqual({ status: "reconciled", outcome: "approved", recorded: "applied" });
    const rec = calls.rpc.find((c) => c.name === "payment_record_result");
    expect(rec?.args).toMatchObject({ p_payment_id: PAYMENT, p_event: "status_check" });
    expect(recorded).toMatchObject({ outcome: "approved", approvedAmount: 25 });
    expect(mock.callsTo(`GET /v1/payment_intents/${String(payment.provider_txn)}`)).toHaveLength(1);
    expect(JSON.stringify(recorded)).not.toContain(KEY);
  });

  it.each(["pending", "approved", "declined", "cancelled", "error"])(
    "a %s payment is acknowledged and left alone (the sale result is the trigger)",
    async (state) => {
      payment.state = state;
      const r = await reconcileStripeWebhook(webhookDeps(), {
        terminalId: TERMINAL,
        ...(await signed(event(String(payment.provider_txn)))),
      });
      expect(r.status).toBe("ignored");
      expect(mock.calls).toHaveLength(0);
      expect(calls.rpc.some((c) => c.name === "payment_record_result")).toBe(false);
    },
  );

  it("events for another org, another PaymentIntent, or no Filletry payment are ignored", async () => {
    const d = webhookDeps();
    const otherOrg = "0b000000-0000-4000-8000-000000000001";
    for (const ev of [
      event(String(payment.provider_txn), { org_id: otherOrg, payment_id: PAYMENT }),
      event("pi_other"),
      event("pi_x", {}),
      { id: "evt_2", type: "charge.refunded", data: { object: { id: "ch_1", object: "charge" } } },
    ]) {
      const r = await reconcileStripeWebhook(d, { terminalId: TERMINAL, ...(await signed(ev)) });
      expect(r.status).toBe("ignored");
    }
    expect(calls.rpc.some((c) => c.name === "payment_record_result")).toBe(false);
  });

  it("a bad signature is a 400; an unknown terminal a 404 — nothing is read or recorded", async () => {
    const { payload } = await signed(event("pi_1"));
    await expect(
      reconcileStripeWebhook(webhookDeps(), {
        terminalId: TERMINAL,
        payload,
        signature: `t=${NOW},v1=00`,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      reconcileStripeWebhook(webhookDeps(), { terminalId: "nope", payload, signature: null }),
    ).rejects.toMatchObject({ status: 404 });
    const noSecret = { ...webhookDeps(), webhookSecret: undefined };
    await expect(
      reconcileStripeWebhook(noSecret, { terminalId: TERMINAL, payload, signature: null }),
    ).rejects.toMatchObject({ status: 404 });
    expect(calls.rpc.filter((c) => c.name !== "payment_terminal_webhook_secret")).toHaveLength(0);
  });

  it("the route reads the raw body and Stripe-Signature, mapping errors to statuses", async () => {
    const route = stripeWebhookRoute(webhookDeps);
    const ctx = { params: Promise.resolve({ terminalId: TERMINAL }) };
    const { payload, signature } = await signed(event(String(payment.provider_txn)));
    const ok = await route(
      new Request("http://localhost/x", {
        method: "POST",
        body: payload,
        headers: { "stripe-signature": signature },
      }),
      ctx,
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "reconciled" });
    const bad = await route(
      new Request("http://localhost/x", { method: "POST", body: payload }),
      ctx,
    );
    expect(bad.status).toBe(400);
  });
});
