// stripe_terminal adapter against the in-memory Stripe mock (docs/05-PAYMENTS.md §5, §6).
// Every docs/05 §6 case is a test named after it. The clock is injected: a 120 s wait at the
// reader runs instantly. The key is generated per run; nothing real is used.
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { stripeSignature } from "../../../supabase/functions/_shared/stripe-billing.ts";
import { StripeMock, type ReaderScript } from "../test/stripe-mock.ts";
import type { SaleResult, TerminalConfig } from "./provider.ts";
import { providerFor } from "./registry.ts";
import {
  STRIPE_API_VERSION,
  createStripeTerminalProvider,
  parseStripeTerminalEvent,
  stripeCardMeta,
  stripeConnectionToken,
  stripeTerminalProvider,
  stripeWebhookSignature,
  verifyStripeWebhook,
} from "./stripe-terminal.ts";

const KEY = `rk_test_${randomBytes(16).toString("hex")}`;
const TIMEOUT = 120_000;

let mock: StripeMock;
let clock: number;
let onSleep: ((t: number) => Promise<void>) | null;
let terminal: TerminalConfig;

function provider() {
  return createStripeTerminalProvider({
    fetch: mock.fetch,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      await onSleep?.(clock);
    },
  });
}

const context = {
  orgId: "00000000-0000-4000-8000-000000000001",
  paymentId: "00000000-0000-4000-8000-0000000000aa",
};

function sale(ref = "a1b2c3d4e5f6a1b2c3d4e5f6-1", amount = 42.5, script?: ReaderScript) {
  if (script) mock.script(script);
  return provider().sale({ terminal, amount, ref, timeoutMs: TIMEOUT, context });
}

function first<T>(xs: T[]): T {
  const x = xs[0];
  if (x === undefined) throw new Error("expected at least one call");
  return x;
}

/** No result, raw payload or recorded error may carry the key or a client secret. */
function expectClean(x: unknown) {
  const s = JSON.stringify(x);
  expect(s).not.toContain(KEY);
  expect(s).not.toMatch(/_secret_/);
}

beforeEach(() => {
  mock = new StripeMock(KEY, ["tmr_A"]);
  clock = 0;
  onSleep = null;
  terminal = { stripe_reader_id: "tmr_A", stripe_location_id: "tml_L1", secret: KEY };
});

describe("§6 approved", () => {
  it("creates a card_present PaymentIntent with our metadata, processes it on the reader and maps the card", async () => {
    const r = await sale();
    expect(r).toMatchObject({
      outcome: "approved",
      approvedAmount: 42.5,
      providerRef: "a1b2c3d4e5f6a1b2c3d4e5f6-1",
      card: {
        brand: "VISA",
        last4: "4242",
        entryMode: "chip",
        authCode: "123456",
        hostResponseCode: "00",
      },
    });
    expect(r.providerTxn).toMatch(/^pi_/);
    const create = first(mock.callsTo("POST /v1/payment_intents"));
    expect(create.params).toMatchObject({
      amount: "4250",
      currency: "usd",
      "payment_method_types[0]": "card_present",
      capture_method: "automatic",
      "metadata[org_id]": context.orgId,
      "metadata[payment_id]": context.paymentId,
      "metadata[provider_ref]": "a1b2c3d4e5f6a1b2c3d4e5f6-1",
    });
    expect(create.headers["idempotency-key"]).toBe("filletry-pi-a1b2c3d4e5f6a1b2c3d4e5f6-1");
    expect(create.headers["stripe-version"]).toBe(STRIPE_API_VERSION);
    const process = first(mock.callsTo("POST /v1/terminal/readers/tmr_A/process_payment_intent"));
    expect(process.params.payment_intent).toBe(r.providerTxn);
    expectClean(r);
  });

  it("waits while the customer is at the reader", async () => {
    const r = await sale(undefined, 10, { action: "approve", afterPolls: 5 });
    expect(r.outcome).toBe("approved");
    expect(clock).toBe(4_000);
  });

  it("is registered as the stripe_terminal provider", () => {
    expect(providerFor("stripe_terminal")).toBe(stripeTerminalProvider);
    expect(stripeTerminalProvider.kind).toBe("stripe_terminal");
  });
});

describe("§6 partial approval", () => {
  it("reports the amount actually received", async () => {
    const r = await sale(undefined, 42.5, { action: "approve", amountReceived: 3000 });
    expect(r).toMatchObject({ outcome: "approved", approvedAmount: 30 });
    expect(r.message).toMatch(/Partially approved/);
  });
});

describe("§6 declined by the issuer (Dejavoo's 1012 case)", () => {
  it("is a decline with the bank's reason — never shown as cancelled — and the PaymentIntent is cancelled", async () => {
    const r = await sale(undefined, 42.5, {
      action: "decline",
      decline: { decline_code: "insufficient_funds", message: "Your card has insufficient funds." },
    });
    expect(r.outcome).toBe("declined");
    expect(r.message).toBe("Declined by the bank: Your card has insufficient funds.");
    expect(r.card).toMatchObject({
      declineReason: "Your card has insufficient funds.",
      last4: "0002",
    });
    expect(mock.intent(r.providerTxn!).status).toBe("canceled");
  });
});

describe("§6 cashier cancel", () => {
  it("abort clears the reader; the sale cancels the PaymentIntent and reports cancelled", async () => {
    const p = provider();
    let aborted: { ok: boolean } | null = null;
    onSleep = async (t) => {
      if (t === 3_000) aborted = await p.abort({ terminal, ref: "ref-cancel" });
    };
    mock.script({ action: "hold" });
    const r = await p.sale({
      terminal,
      amount: 20,
      ref: "ref-cancel",
      timeoutMs: TIMEOUT,
      context,
    });
    expect(aborted).toMatchObject({ ok: true });
    expect(r.outcome).toBe("cancelled");
    expect(clock).toBe(3_000);
    expect(mock.intent(r.providerTxn!).status).toBe("canceled");
    expect(mock.callsTo("POST /v1/terminal/readers/tmr_A/cancel_action")).toHaveLength(1);
  });

  it("abort never clears a reader that is collecting another payment", async () => {
    mock.script({ action: "hold" });
    const other = createStripeTerminalProvider({
      fetch: mock.fetch,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (clock === 2_000) {
          const res = await provider().abort({ terminal, ref: "someone-else-1" });
          expect(res.ok).toBe(false);
          expect(res.raw).toMatchObject({ reason: "reader_busy_with_another_payment" });
          mock.finish("tmr_A", "approve");
        }
      },
    });
    const r = await other.sale({ terminal, amount: 5, ref: "mine-1", timeoutMs: TIMEOUT });
    expect(r.outcome).toBe("approved");
    expect(mock.callsTo("POST /v1/terminal/readers/tmr_A/cancel_action")).toHaveLength(0);
  });

  it("a card already being authorised cannot be interrupted: abort fails and the sale's answer stands", async () => {
    const p = provider();
    onSleep = async (t) => {
      if (t === 1_000) expect((await p.abort({ terminal, ref: "ref-busy" })).ok).toBe(false);
    };
    mock.script({ action: "approve", afterPolls: 3, authorising: true });
    const r = await p.sale({ terminal, amount: 7, ref: "ref-busy", timeoutMs: TIMEOUT });
    expect(r.outcome).toBe("approved");
  });

  it("the customer cancelling on the reader is cancelled", async () => {
    const r = await sale(undefined, 9, { action: "customer_cancel" });
    expect(r).toMatchObject({
      outcome: "cancelled",
      message: "The customer cancelled on the reader.",
    });
    expect(mock.intent(r.providerTxn!).status).toBe("canceled");
  });

  it("nobody presents a card: at the timeout the reader is cleared and the sale is cancelled", async () => {
    const r = await sale(undefined, 9, { action: "hold" });
    expect(r).toMatchObject({
      outcome: "cancelled",
      message: "Timed out at the reader — nothing was charged.",
    });
    expect(clock).toBe(TIMEOUT);
    expect(mock.callsTo("POST /v1/terminal/readers/tmr_A/cancel_action")).toHaveLength(1);
    expect(mock.intent(r.providerTxn!).status).toBe("canceled");
  });
});

describe("§6 timeout → status", () => {
  async function lostDuringSale(): Promise<SaleResult> {
    onSleep = async (t) => {
      if (t === 2_000) mock.outage(true);
    };
    const r = await sale("ref-lost-1", 30, { action: "hold" });
    mock.outage(false);
    return r;
  }

  it("Stripe unreachable until the timeout is indeterminate with the PaymentIntent id", async () => {
    const r = await lostDuringSale();
    expect(r).toMatchObject({ outcome: "indeterminate", providerRef: "ref-lost-1" });
    expect(r.providerTxn).toMatch(/^pi_/);
    expectClean(r);
  });

  it("→ status approved: the customer paid meanwhile", async () => {
    const r = await lostDuringSale();
    mock.finish("tmr_A", "approve");
    const s = await provider().status({ terminal, ref: "ref-lost-1", txn: r.providerTxn });
    expect(s).toMatchObject({ outcome: "approved", approvedAmount: 30, card: { last4: "4242" } });
  });

  it("→ status cancelled: not paid and no longer on the reader — status cancels it so it never can be", async () => {
    const r = await lostDuringSale();
    mock.finish("tmr_A", "customer_cancel");
    const s = await provider().status({ terminal, ref: "ref-lost-1", txn: r.providerTxn });
    expect(s.outcome).toBe("cancelled");
    expect(mock.intent(r.providerTxn!).status).toBe("canceled");
  });

  it("status while the customer is still at the reader stays indeterminate (never cancels a live sale)", async () => {
    const r = await lostDuringSale();
    const s = await provider().status({ terminal, ref: "ref-lost-1", txn: r.providerTxn });
    expect(s).toMatchObject({
      outcome: "indeterminate",
      message: "The payment is still on the card reader.",
    });
    expect(mock.intent(r.providerTxn!).status).toBe("requires_payment_method");
  });

  it("status without the PaymentIntent id finds it by our ref; an unknown ref stays indeterminate", async () => {
    const r = await sale("ref-search-1", 12);
    const s = await provider().status({ terminal, ref: "ref-search-1" });
    expect(s).toMatchObject({ outcome: "approved", providerTxn: r.providerTxn });
    expect((await provider().status({ terminal, ref: "never-sent-1" })).outcome).toBe(
      "indeterminate",
    );
  });

  it("status refuses a PaymentIntent that belongs to another payment", async () => {
    const r = await sale("ref-x-1", 12);
    const s = await provider().status({ terminal, ref: "ref-y-1", txn: r.providerTxn });
    expect(s).toMatchObject({
      outcome: "indeterminate",
      message: "That PaymentIntent belongs to another payment.",
    });
  });

  it("the reader loses its answer but Stripe approved (connection_error): approved", async () => {
    const r = await sale(undefined, 15, { action: "paid_connection_error" });
    expect(r.outcome).toBe("approved");
  });

  it("process call times out but reached the reader: the sale keeps watching", async () => {
    mock.failOn("POST /v1/terminal/readers/tmr_A/process_payment_intent", "lost");
    const r = await sale(undefined, 15);
    expect(r.outcome).toBe("approved");
  });

  it("process call never reached the reader: after the pickup grace it is an error and the PaymentIntent is cancelled", async () => {
    mock.failOn("POST /v1/terminal/readers/tmr_A/process_payment_intent", "network");
    const r = await sale(undefined, 15);
    expect(r).toMatchObject({
      outcome: "error",
      message: "The card reader never showed the payment — nothing was charged.",
    });
    expect(clock).toBe(10_000);
    expect(mock.intent(r.providerTxn!).status).toBe("canceled");
  });
});

describe("§6 transport error", () => {
  it("Stripe unreachable when creating the PaymentIntent: error, the reader is never asked", async () => {
    mock.failOn("POST /v1/payment_intents", "network");
    const r = await sale();
    expect(r).toMatchObject({
      outcome: "error",
      message: "Could not reach Stripe — nothing was charged. Try again.",
    });
    expect(mock.callsTo("POST /v1/terminal*")).toHaveLength(0);
    expectClean(r);
  });

  it("a 5xx is a transport error too", async () => {
    mock.failOn("POST /v1/payment_intents", { status: 503 });
    expect((await sale()).outcome).toBe("error");
  });
});

describe("§6 config error", () => {
  it("no reader id, a secret key instead of a restricted key, or no key: error without calling Stripe", async () => {
    const p = provider();
    for (const t of [
      { ...terminal, stripe_reader_id: undefined },
      { ...terminal, stripe_reader_id: "reader-1" },
      { ...terminal, secret: `sk_test_${randomBytes(8).toString("hex")}` },
      { ...terminal, secret: "" },
    ]) {
      const r = await p.sale({ terminal: t, amount: 5, ref: "cfg-1", timeoutMs: TIMEOUT });
      expect(r.outcome).toBe("error");
    }
    expect(mock.calls).toHaveLength(0);
  });

  it("a key Stripe refuses (401) is an error naming the key's permissions", async () => {
    terminal = { ...terminal, secret: `rk_test_${randomBytes(8).toString("hex")}` };
    const r = await sale();
    expect(r).toMatchObject({ outcome: "error" });
    expect(r.message).toMatch(/restricted key/);
  });

  it("an offline reader is an error and the PaymentIntent is cancelled", async () => {
    mock.readers.get("tmr_A")!.offline = true;
    const r = await sale();
    expect(r.outcome).toBe("error");
    expect(r.message).toMatch(/offline/);
    expect(mock.intent(r.providerTxn!).status).toBe("canceled");
  });

  it("an unknown reader is an error", async () => {
    terminal = { ...terminal, stripe_reader_id: "tmr_Missing" };
    expect((await sale()).outcome).toBe("error");
  });
});

describe("§6 reverse", () => {
  it("reverse → void: an uncaptured PaymentIntent is cancelled", async () => {
    const pi = mock.seedIntent({
      amount: 2500,
      status: "requires_capture",
      capture_method: "manual",
    });
    const r = await provider().reverse({
      terminal,
      originalRef: "orig-1",
      originalTxn: pi.id,
      amount: 25,
    });
    expect(r.outcome).toBe("voided");
    expect(mock.intent(pi.id).status).toBe("canceled");
    expect(mock.callsTo("POST /v1/refunds")).toHaveLength(0);
  });

  it("reverse → refund: a captured payment is refunded for the remaining amount", async () => {
    const s = await sale("orig-2", 25);
    const r = await provider().reverse({
      terminal,
      originalRef: "orig-2",
      originalTxn: s.providerTxn,
      amount: 25,
    });
    expect(r.outcome).toBe("refunded");
    expect(r.providerTxn).toMatch(/^re_/);
    const call = first(mock.callsTo("POST /v1/refunds"));
    expect(call.params).toMatchObject({
      payment_intent: s.providerTxn,
      amount: "2500",
      "metadata[provider_ref]": "orig-2",
    });
    // a second reverse of the same money is refused by Stripe (nothing left), never paid twice
    const again = await provider().reverse({
      terminal,
      originalRef: "orig-2",
      originalTxn: s.providerTxn,
      amount: 25,
    });
    expect(again.outcome).toBe("declined");
  });

  it("refund returns an amount under its own ref (idempotent per refund)", async () => {
    const s = await sale("orig-3", 40);
    const r = await provider().refund({
      terminal,
      amount: 10,
      ref: "orig-3-r1",
      originalTxn: s.providerTxn,
    });
    expect(r.outcome).toBe("refunded");
    const call = first(mock.callsTo("POST /v1/refunds"));
    expect(call.params.amount).toBe("1000");
    expect(call.headers["idempotency-key"]).toBe("filletry-refund-orig-3-r1");
    expect(mock.intent(s.providerTxn!).refunded).toBe(1000);
  });

  it("a refund whose answer is lost is indeterminate (the money may be back); a failed one is declined", async () => {
    const s = await sale("orig-4", 40);
    mock.failOn("POST /v1/refunds", "lost");
    const lost = await provider().refund({
      terminal,
      amount: 10,
      ref: "orig-4-r1",
      originalTxn: s.providerTxn,
    });
    expect(lost.outcome).toBe("indeterminate");
    expect(mock.intent(s.providerTxn!).refunded).toBe(1000);
    mock.refundStatus = "failed";
    expect(
      (
        await provider().refund({
          terminal,
          amount: 5,
          ref: "orig-4-r2",
          originalTxn: s.providerTxn,
        })
      ).outcome,
    ).toBe("declined");
  });

  it("a pending refund is indeterminate, never refunded — it can still fail (pending → failed)", async () => {
    const s = await sale("orig-5", 40);
    mock.refundStatus = "pending";
    const r = await provider().refund({
      terminal,
      amount: 10,
      ref: "orig-5-r1",
      originalTxn: s.providerTxn,
    });
    expect(r.outcome).toBe("indeterminate");
    expect(r.providerTxn).toMatch(/^re_/);
    expect(r.raw).toMatchObject({ refund: { status: "pending" } });

    // Stripe later fails it (e.g. insufficient balance): the money never went back
    mock.settleRefund(r.providerTxn!, "failed");
    expect(mock.intent(s.providerTxn!).refunded).toBe(0);
    // so after the manager resolves it as not reversed, the full amount is refundable again
    mock.refundStatus = "succeeded";
    const again = await provider().refund({
      terminal,
      amount: 40,
      ref: "orig-5-r2",
      originalTxn: s.providerTxn,
    });
    expect(again.outcome).toBe("refunded");
  });

  it("a pending reverse is indeterminate too (pending → failed)", async () => {
    const s = await sale("orig-6", 25);
    mock.refundStatus = "pending";
    const r = await provider().reverse({
      terminal,
      originalRef: "orig-6",
      originalTxn: s.providerTxn,
      amount: 25,
    });
    expect(r.outcome).toBe("indeterminate");
    mock.settleRefund(r.providerTxn!, "failed");
    expect(mock.intent(s.providerTxn!).refunded).toBe(0);
  });

  it("no PaymentIntent on the payment or a bad config: error, nothing sent", async () => {
    expect((await provider().reverse({ terminal, originalRef: "x-1" })).outcome).toBe("error");
    expect(
      (
        await provider().refund({
          terminal: { ...terminal, secret: "" },
          amount: 1,
          ref: "x-1",
          originalTxn: "pi_1",
        })
      ).outcome,
    ).toBe("error");
    expect(mock.calls).toHaveLength(0);
  });
});

describe("§6 duplicate ref rejected", () => {
  it("the same ref again never reaches the reader a second time", async () => {
    const first = await sale("dup-1", 10);
    const again = await sale("dup-1", 10);
    expect(again).toMatchObject({ outcome: "error", providerTxn: first.providerTxn });
    expect(again.message).toMatch(/Duplicate reference/);
    expect(mock.callsTo("POST /v1/terminal/readers/tmr_A/process_payment_intent")).toHaveLength(1);
  });

  it("the same ref with another amount is refused by Stripe's idempotency check", async () => {
    await sale("dup-2", 10);
    const again = await sale("dup-2", 11);
    expect(again.outcome).toBe("error");
    expect(again.message).toMatch(/Duplicate reference/);
  });
});

describe("§6 retry uses a new ref", () => {
  it("after a decline the next attempt is a new PaymentIntent under a new idempotency key", async () => {
    const first = await sale("order-1", 20, { action: "decline" });
    const retry = await sale("order-2", 20);
    expect(first.outcome).toBe("declined");
    expect(retry.outcome).toBe("approved");
    expect(retry.providerTxn).not.toBe(first.providerTxn);
    expect(mock.intent(first.providerTxn!).status).toBe("canceled");
    const keys = mock.callsTo("POST /v1/payment_intents").map((c) => c.headers["idempotency-key"]);
    expect(keys).toEqual(["filletry-pi-order-1", "filletry-pi-order-2"]);
  });
});

describe("card meta mapping", () => {
  it.each([
    ["contact_emv", "chip"],
    ["contactless_emv", "contactless"],
    ["contactless_magstripe_mode", "contactless"],
    ["magnetic_stripe_track2", "swipe"],
    ["magnetic_stripe_fallback", "swipe"],
    ["something_new", undefined],
  ])("read_method %s → entryMode %s", (readMethod, entryMode) => {
    const meta = stripeCardMeta({
      id: "pi_1",
      status: "succeeded",
      amount: 100,
      latest_charge: {
        id: "ch_1",
        payment_method_details: {
          card_present: { brand: "mastercard", last4: "4444", read_method: readMethod },
        },
      },
    });
    expect(meta).toEqual({
      brand: "MASTERCARD",
      last4: "4444",
      ...(entryMode ? { entryMode } : {}),
    });
  });
});

describe("scrub", () => {
  it("redacts client secrets, keys and card numbers", () => {
    const out = JSON.stringify(
      stripeTerminalProvider.scrub({
        client_secret: "pi_1_secret_x",
        note: `Bearer ${KEY}`,
        pan: "4242424242424242",
      }),
    );
    expectClean(out);
    expect(out).not.toContain("4242424242424242");
  });
});

describe("connection token", () => {
  it("is created with the terminal's location; only the token secret is returned", async () => {
    const t = await stripeConnectionToken(terminal, { fetch: mock.fetch });
    expect(t.secret).toMatch(/^pst_test_/);
    expect(t.location).toBe("tml_L1");
    expect(first(mock.callsTo("POST /v1/terminal/connection_tokens")).params.location).toBe(
      "tml_L1",
    );
    expectClean(t);
  });

  it("refuses a terminal without a restricted key", async () => {
    await expect(
      stripeConnectionToken({ ...terminal, secret: "" }, { fetch: mock.fetch }),
    ).rejects.toThrow(/restricted key/);
    expect(mock.calls).toHaveLength(0);
  });
});

describe("webhook (reconciles indeterminate only — the parsing half)", () => {
  const secret = `whsec_${randomBytes(16).toString("hex")}`;
  const now = 1_800_000_000;
  const event = (
    type: string,
    metadata: Record<string, string> = {
      payment_id: context.paymentId,
      org_id: context.orgId,
      provider_ref: "r-1",
    },
  ) => ({
    id: "evt_1",
    type,
    data: { object: { id: "pi_9", object: "payment_intent", metadata } },
  });

  it("verifies Stripe's v1 signature, rejects tampering and replays", async () => {
    const payload = JSON.stringify(event("payment_intent.succeeded"));
    const sig = await stripeWebhookSignature(payload, secret, now);
    expect(await verifyStripeWebhook(payload, `t=${now},v1=${sig}`, secret, now)).toBe(true);
    expect(await verifyStripeWebhook(`${payload} `, `t=${now},v1=${sig}`, secret, now)).toBe(false);
    expect(await verifyStripeWebhook(payload, `t=${now},v1=${sig}`, `${secret}x`, now)).toBe(false);
    expect(await verifyStripeWebhook(payload, `t=${now},v1=${sig}`, secret, now + 301)).toBe(false);
    expect(await verifyStripeWebhook(payload, null, secret, now)).toBe(false);
  });

  it("signs exactly like the billing webhook's verifier (one scheme)", async () => {
    expect(await stripeWebhookSignature("{}", secret, now)).toBe(
      await stripeSignature("{}", secret, now),
    );
  });

  it("names our payment for the PaymentIntent events; anything else is ignored", () => {
    expect(parseStripeTerminalEvent(event("payment_intent.succeeded"))).toEqual({
      eventId: "evt_1",
      type: "payment_intent.succeeded",
      paymentIntentId: "pi_9",
      orgId: context.orgId,
      paymentId: context.paymentId,
      providerRef: "r-1",
    });
    expect(parseStripeTerminalEvent(event("payment_intent.canceled"))?.type).toBe(
      "payment_intent.canceled",
    );
    expect(parseStripeTerminalEvent(event("charge.refunded"))).toBeNull();
    expect(parseStripeTerminalEvent(event("payment_intent.succeeded", {}))).toBeNull();
    expect(parseStripeTerminalEvent(null)).toBeNull();
  });
});
