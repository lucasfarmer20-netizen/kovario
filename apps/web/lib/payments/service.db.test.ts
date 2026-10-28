// WP-16 route-handler flow against the local Supabase with the fake provider (docs/05 §6):
// the cashier's own session for begin/read, the service role for results — exactly what the
// /api/payments/* handlers wire up. Charge flow states (approved, partial, declined,
// cancelled via Cancel, indeterminate → status, thrown transport error), replay safety,
// indeterminate blocking retry, cash via the manual adapter, and refunds that never release.
import { FakeProvider, manualProvider, type ProviderKind } from "payments";
import type { Json } from "db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOrg,
  createUser,
  dropOrg,
  serviceRoleClient,
  type TestOrg,
  type TestUser,
} from "../../../../packages/db/src/testing/local-supabase";
import {
  PaymentRequestError,
  abortPayment,
  chargePayment,
  checkPaymentStatus,
  reversePayment,
  type PaymentsDeps,
} from "./service";

type Payment = { id: string; state: string; amount: number; attempt: number; provider_ref: string };
type Order = {
  id: string;
  state: string;
  totals: { due: number; paid: number };
  payments: Payment[];
};
type Result = { status: string; payment: Payment; order: Order | null };

const admin = serviceRoleClient();
const cid = (p: string) => `${p}-${randomUUID()}`;
const res = (j: Json) => j as unknown as Result;

describe("payments route flow (fake provider)", { timeout: 60_000 }, () => {
  let org: TestOrg;
  let cashier: TestUser;
  let manager: TestUser;
  let customerId = "";
  let terminalId = "";
  let fake: FakeProvider;

  const deps = (user: TestUser = cashier): PaymentsDeps => ({
    caller: user.client,
    service: admin,
    providerFor: (kind: ProviderKind) => (kind === "manual" ? manualProvider : fake),
    timeoutMs: 1000,
  });

  /** A fresh cart holding one open charge of `amount` for the customer. */
  async function cart(amount: number): Promise<string> {
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

  async function settleAll(): Promise<void> {
    // keep later carts to their own charge
    await admin
      .from("charge")
      .update({ state: "voided" })
      .eq("customer_id", customerId)
      .eq("state", "open");
  }

  async function order(id: string): Promise<Order> {
    const { data, error } = await cashier.client.rpc("register_order", { p_order_id: id });
    if (error) throw error;
    return data as unknown as Order;
  }

  async function events(paymentId: string): Promise<string[]> {
    const { data } = await admin
      .from("payment_event")
      .select("kind, at")
      .eq("payment_id", paymentId);
    return (data ?? []).map((e) => e.kind).sort();
  }

  beforeAll(async () => {
    org = await createOrg();
    // amounts below are untaxed; tax is covered by 16_register.test.sql and register.db.test.ts
    const { error: settingsError } = await admin
      .from("org")
      .update({ settings: { tax: { mode: "none" } } })
      .eq("id", org.id);
    if (settingsError) throw settingsError;
    cashier = await createUser(org, "cashier");
    manager = await createUser(org, "manager");
    const { data: c, error } = await admin
      .from("customer")
      .insert({ org_id: org.id, name: "Flow Fran", phone: "+19075551698" })
      .select("id")
      .single();
    if (error) throw error;
    customerId = c.id;
    const { data: t, error: tErr } = await admin
      .from("payment_terminal")
      .insert({
        org_id: org.id,
        name: "Dejavoo 1",
        provider: "dejavoo_spin",
        config: { tpn: "T-1" },
      })
      .select("id")
      .single();
    if (tErr) throw tErr;
    terminalId = t.id;
  });

  afterAll(async () => {
    if (org) await dropOrg(org);
  });

  it("approved card: Charge → sale on the terminal with the payment's ref → paid hook settles the cart", async () => {
    fake = new FakeProvider();
    await settleAll();
    const orderId = await cart(25);
    const id = cid("sale");
    const r = res(
      await chargePayment(deps(), {
        clientActionId: id,
        orderId,
        amount: 25,
        terminalId,
        tender: "card",
      }),
    );
    expect(r.status).toBe("applied");
    expect(r.payment.state).toBe("approved");
    expect(r.order?.state).toBe("paid");
    expect(fake.callsOf("sale")).toMatchObject([{ amount: 25, ref: r.payment.provider_ref }]);
    expect(await events(r.payment.id)).toEqual(["paid_hook", "sale_requested", "sale_result"]);

    // A replay of the same Charge (double submit / lost response) never reaches the terminal again.
    const again = res(
      await chargePayment(deps(), {
        clientActionId: id,
        orderId,
        amount: 25,
        terminalId,
        tender: "card",
      }),
    );
    expect(again.status).toBe("replayed");
    expect(fake.callsOf("sale")).toHaveLength(1);
  });

  it("partial approval: approved for the captured amount; the rest is collected in cash on a second line", async () => {
    fake = new FakeProvider().queueSale({ outcome: "approved", approvedAmount: 4 });
    await settleAll();
    const orderId = await cart(10);
    const partial = res(
      await chargePayment(deps(), {
        clientActionId: cid("sale"),
        orderId,
        amount: 10,
        terminalId,
        tender: "card",
      }),
    );
    expect(partial.status).toBe("applied:partial");
    expect(partial.order).toMatchObject({ state: "open", totals: { paid: 4, due: 6 } });
    const cash = res(
      await chargePayment(deps(), {
        clientActionId: cid("cash"),
        orderId,
        amount: 6,
        tender: "cash",
      }),
    );
    expect(cash.payment).toMatchObject({ state: "approved", amount: 6 });
    expect(cash.order?.state).toBe("paid");
  });

  it("declined: the bank's reason is kept; the retry is attempt 2 with a new ref", async () => {
    fake = new FakeProvider().queueSale({
      outcome: "declined",
      card: { hostResponseCode: "51", declineReason: "Insufficient funds" },
    });
    await settleAll();
    const orderId = await cart(12);
    const declined = res(
      await chargePayment(deps(), {
        clientActionId: cid("sale"),
        orderId,
        amount: 12,
        terminalId,
        tender: "card",
      }),
    );
    expect(declined.payment).toMatchObject({ state: "declined", attempt: 1 });
    const retry = res(
      await chargePayment(deps(), {
        clientActionId: cid("sale"),
        orderId,
        amount: 12,
        terminalId,
        tender: "card",
      }),
    );
    expect(retry.payment).toMatchObject({ state: "approved", attempt: 2 });
    expect(retry.payment.provider_ref).not.toBe(declined.payment.provider_ref);
  });

  it("indeterminate blocks retry until a status check resolves it", async () => {
    fake = new FakeProvider()
      .queueSale({ outcome: "indeterminate" })
      .queueStatus({ outcome: "indeterminate" });
    await settleAll();
    const orderId = await cart(15);
    const first = res(
      await chargePayment(deps(), {
        clientActionId: cid("sale"),
        orderId,
        amount: 15,
        terminalId,
        tender: "card",
      }),
    );
    expect(first.payment.state).toBe("indeterminate");
    expect(fake.callsOf("status")).toHaveLength(1); // docs/05 §2.4: status is asked at once

    await expect(
      chargePayment(deps(), {
        clientActionId: cid("sale"),
        orderId,
        amount: 15,
        terminalId,
        tender: "card",
      }),
    ).rejects.toMatchObject({ status: 409 } satisfies Partial<PaymentRequestError>);
    expect(fake.callsOf("sale")).toHaveLength(1); // never charged twice

    fake.queueStatus({ outcome: "approved", approvedAmount: 15 });
    const resolved = res(await checkPaymentStatus(deps(), { paymentId: first.payment.id }));
    expect(resolved.payment.state).toBe("approved");
    expect((await order(orderId)).state).toBe("paid");
  });

  it("a thrown transport error is indeterminate (it may have reached the terminal) and is followed by status", async () => {
    fake = new FakeProvider()
      .queueSale({ outcome: "approved", throws: "socket hang up" })
      .queueStatus({ outcome: "cancelled" });
    await settleAll();
    const orderId = await cart(9);
    const r = res(
      await chargePayment(deps(), {
        clientActionId: cid("sale"),
        orderId,
        amount: 9,
        terminalId,
        tender: "card",
      }),
    );
    expect(r.payment.state).toBe("cancelled");
    expect(await events(r.payment.id)).toEqual(["sale_requested", "sale_result", "status_check"]);
  });

  it("Cancel unblocks immediately: abort is sent while the sale is still waiting; the sale then records cancelled", async () => {
    fake = new FakeProvider().queueSale({ outcome: "approved", hold: true });
    await settleAll();
    const orderId = await cart(30);
    const sale = chargePayment(deps(), {
      clientActionId: cid("sale"),
      orderId,
      amount: 30,
      terminalId,
      tender: "card",
    });
    let pending: Payment | undefined;
    for (let i = 0; i < 50 && !pending; i++) {
      pending = (await order(orderId)).payments.find((p) => p.state === "pending");
      if (!pending || fake.callsOf("sale").length === 0) {
        pending = undefined;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(pending).toBeDefined();
    const aborted = res(await abortPayment(deps(), { paymentId: pending!.id }));
    expect(aborted.status).toBe("abort_sent");
    expect(res(await sale).payment.state).toBe("cancelled");
    expect(await events(pending!.id)).toContain("abort");
  });

  it("refund (manager): the provider refunds, a refund order records it, nothing is released or settled", async () => {
    fake = new FakeProvider().queueSale({ outcome: "approved", approvedAmount: 5 });
    await settleAll();
    const orderId = await cart(20);
    const paid = res(
      await chargePayment(deps(), {
        clientActionId: cid("sale"),
        orderId,
        amount: 20,
        terminalId,
        tender: "card",
      }),
    );
    await expect(
      reversePayment(deps(), {
        clientActionId: cid("rf"),
        paymentId: paid.payment.id,
        kind: "refund",
        amount: 5,
        reason: "x",
      }),
    ).rejects.toMatchObject({ status: 403 });
    const refunded = (await reversePayment(deps(manager), {
      clientActionId: cid("rf"),
      paymentId: paid.payment.id,
      kind: "refund",
      amount: 5,
      reason: "wrong card",
    })) as unknown as {
      status: string;
      refund_order: { kind: string; paid_hook: { status: string } };
    };
    expect(refunded.status).toBe("refunded");
    expect(refunded.refund_order).toMatchObject({
      kind: "refund",
      paid_hook: { status: "refund" },
    });
    expect(fake.callsOf("refund")).toHaveLength(1);
    const after = await order(orderId);
    expect(after).toMatchObject({ state: "open", totals: { paid: 0 } });
    const { data: charges } = await admin
      .from("charge")
      .select("state")
      .eq("customer_id", customerId)
      .eq("state", "open");
    expect(charges).toHaveLength(1); // the cart's charge is still owed
  });
  it("two managers refunding at once: the second is refused while the first is in flight; one provider refund, one refund order", async () => {
    fake = new FakeProvider()
      .queueSale({ outcome: "approved" })
      .queueRefund({ outcome: "refunded", providerTxn: "TX-R1", delayMs: 300 });
    await settleAll();
    const orderId = await cart(8);
    const paid = res(
      await chargePayment(deps(), {
        clientActionId: cid("sale"),
        orderId,
        amount: 8,
        terminalId,
        tender: "card",
      }),
    );
    const refund = (amount: number) =>
      reversePayment(deps(manager), {
        clientActionId: cid("rf"),
        paymentId: paid.payment.id,
        kind: "refund",
        amount,
        reason: "double click",
      });
    const first = refund(8);
    // the first request has reserved the reversal and is waiting on the (delayed) provider
    for (let i = 0; i < 50 && fake.callsOf("refund").length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await expect(refund(3)).rejects.toMatchObject({
      status: 409,
    } satisfies Partial<PaymentRequestError>);
    expect(((await first) as unknown as { status: string }).status).toBe("refunded");
    expect(fake.callsOf("refund")).toHaveLength(1);
    const { data: refundOrders } = await admin
      .from("register_order")
      .select("refund_amount")
      .eq("refund_payment_id", paid.payment.id);
    expect(refundOrders).toEqual([{ refund_amount: 8 }]);
  });
  it("the provider refunds and THEN the call throws: unresolved, every new refund refused, a manager resolves it", async () => {
    fake = new FakeProvider()
      .queueSale({ outcome: "approved" })
      .queueRefund({ outcome: "refunded", throwsAfter: "socket hang up" });
    await settleAll();
    const orderId = await cart(7);
    const paid = res(
      await chargePayment(deps(), {
        clientActionId: cid("sale"),
        orderId,
        amount: 7,
        terminalId,
        tender: "card",
      }),
    );
    const refund = () =>
      reversePayment(deps(manager), {
        clientActionId: cid("rf"),
        paymentId: paid.payment.id,
        kind: "refund",
        amount: 7,
        reason: "wrong card",
      });
    const first = (await refund()) as unknown as {
      status: string;
      payment: Payment & { reverse_unresolved: boolean };
    };
    expect(fake.performed).toBe(1); // the money went back…
    expect(first.status).toBe("indeterminate"); // …but the register cannot know it
    expect(first.payment).toMatchObject({ state: "approved", reverse_unresolved: true });

    // A retry (new intent, as the UI would send) never reaches the provider again.
    await expect(refund()).rejects.toMatchObject({
      status: 409,
    } satisfies Partial<PaymentRequestError>);
    expect(fake.callsOf("refund")).toHaveLength(1);
    expect(fake.performed).toBe(1);

    // The manager checks the processor and records what happened.
    const { data, error } = await manager.client.rpc("payment_reverse_resolve", {
      p_client_action_id: cid("rr"),
      p_payment_id: paid.payment.id,
      p_outcome: "refunded",
      p_reason: "processor portal shows the refund",
    });
    expect(error).toBeNull();
    expect((data as unknown as { payment: Payment }).payment.state).toBe("refunded");
    const { data: refundOrders } = await admin
      .from("register_order")
      .select("refund_amount")
      .eq("refund_payment_id", paid.payment.id);
    expect(refundOrders).toEqual([{ refund_amount: 7 }]);
  });

  it("a setup failure before the provider is asked is a plain error: nothing reserved stays behind", async () => {
    fake = new FakeProvider().queueSale({ outcome: "approved" });
    await settleAll();
    const orderId = await cart(4);
    const paid = res(
      await chargePayment(deps(), {
        clientActionId: cid("sale"),
        orderId,
        amount: 4,
        terminalId,
        tender: "card",
      }),
    );
    const broken: PaymentsDeps = {
      ...deps(manager),
      providerFor: () => {
        throw new Error("adapter not available");
      },
    };
    const r = (await reversePayment(broken, {
      clientActionId: cid("rf"),
      paymentId: paid.payment.id,
      kind: "refund",
      amount: 4,
      reason: "x",
    })) as unknown as {
      status: string;
      payment: Payment & { reverse_pending_kind: string | null };
    };
    expect(r.status).toBe("error");
    expect(r.payment).toMatchObject({ state: "approved", reverse_pending_kind: null });
  });
  it("partial refund on an open split-payment cart keeps the rest captured; the remainder can be refunded later", async () => {
    fake = new FakeProvider();
    await settleAll();
    const orderId = await cart(20);
    const card = res(
      await chargePayment(deps(), {
        clientActionId: cid("sale"),
        orderId,
        amount: 10,
        terminalId,
        tender: "card",
      }),
    );
    const cash = res(
      await chargePayment(deps(), {
        clientActionId: cid("cash"),
        orderId,
        amount: 5,
        tender: "cash",
      }),
    );
    expect(cash.order).toMatchObject({ state: "open", totals: { paid: 15, due: 5 } });

    type Refunded = {
      status: string;
      payment: Payment & { reversed_amount: number; refundable: number };
    };
    const refund = async (amount: number) =>
      (await reversePayment(deps(manager), {
        clientActionId: cid("rf"),
        paymentId: card.payment.id,
        kind: "refund",
        amount,
        reason: "partial",
      })) as unknown as Refunded;

    const first = await refund(2);
    expect(first.payment).toMatchObject({ state: "approved", reversed_amount: 2, refundable: 8 });
    expect(await order(orderId)).toMatchObject({ state: "open", totals: { paid: 13, due: 7 } });

    await expect(refund(9)).rejects.toMatchObject({
      status: 400,
    } satisfies Partial<PaymentRequestError>);

    const rest = await refund(8);
    expect(rest.payment).toMatchObject({ state: "refunded", reversed_amount: 10, refundable: 0 });
    expect(await order(orderId)).toMatchObject({ state: "open", totals: { paid: 5, due: 15 } });
    expect(fake.callsOf("refund")).toMatchObject([{ amount: 2 }, { amount: 8 }]);
    const { data: refundOrders } = await admin
      .from("register_order")
      .select("refund_amount")
      .eq("refund_payment_id", card.payment.id)
      .order("refund_amount");
    expect(refundOrders).toEqual([{ refund_amount: 2 }, { refund_amount: 8 }]);
  });
  it("an unresolved refund on an open cart blocks the balance payment: nothing completes on credit that may be gone", async () => {
    fake = new FakeProvider()
      .queueSale({ outcome: "approved" })
      .queueRefund({ outcome: "refunded", throwsAfter: "socket hang up" });
    await settleAll();
    const orderId = await cart(20);
    const card = res(
      await chargePayment(deps(), {
        clientActionId: cid("sale"),
        orderId,
        amount: 10,
        terminalId,
        tender: "card",
      }),
    );
    const refund = (await reversePayment(deps(manager), {
      clientActionId: cid("rf"),
      paymentId: card.payment.id,
      kind: "refund",
      amount: 10,
      reason: "customer left",
    })) as unknown as { status: string };
    expect(refund.status).toBe("indeterminate");
    const blocked = (await order(orderId)) as Order & { reversal_payment_id: string | null };
    expect(blocked).toMatchObject({
      state: "open",
      reversal_payment_id: card.payment.id,
      totals: { due: 10 },
    });

    await expect(
      chargePayment(deps(), { clientActionId: cid("cash"), orderId, amount: 10, tender: "cash" }),
    ).rejects.toMatchObject({ status: 409 } satisfies Partial<PaymentRequestError>);
    expect((await order(orderId)).state).toBe("open");
  });
});

describe(
  "abort: a thrown adapter error is scrubbed before it is stored (rule 5)",
  { timeout: 60_000 },
  () => {
    it("the abort event payload never carries the secret from the exception text", async () => {
      const org = await createOrg();
      try {
        await admin
          .from("org")
          .update({ settings: { tax: { mode: "none" } } })
          .eq("id", org.id);
        const cashier = await createUser(org, "cashier");
        const { data: c } = await admin
          .from("customer")
          .insert({ org_id: org.id, name: "Abort Abe", phone: "+19075551697" })
          .select("id")
          .single();
        await admin.from("charge").insert({
          org_id: org.id,
          number: "CHG-9201",
          customer_id: c!.id,
          kind: "adjustment",
          source_type: "manual",
          qty: 1,
          unit: "each",
          unit_price: 5,
        });
        const { data: t } = await admin
          .from("payment_terminal")
          .insert({ org_id: org.id, name: "Dejavoo 1", provider: "dejavoo_spin" })
          .select("id")
          .single();
        const { data: cartData } = await cashier.client.rpc("register_load_outstanding", {
          p_client_action_id: cid("load"),
          p_customer_id: c!.id,
        });
        const orderId = (cartData as unknown as Order).id;
        const fake = new FakeProvider()
          .queueSale({ outcome: "approved", hold: true })
          .failNextAbort('abort failed: {"Authkey":"SECRET-AUTHKEY-1","Tpn":"T1"}');
        const deps: PaymentsDeps = {
          caller: cashier.client,
          service: admin,
          providerFor: () => fake,
        };
        const sale = chargePayment(deps, {
          clientActionId: cid("sale"),
          orderId,
          amount: 5,
          terminalId: t!.id,
          tender: "card",
        });
        let paymentId = "";
        let ref = "";
        for (let i = 0; i < 50 && !paymentId; i++) {
          const { data } = await admin
            .from("payment")
            .select("id, provider_ref")
            .eq("register_order_id", orderId)
            .eq("state", "pending")
            .maybeSingle();
          if (data && fake.callsOf("sale").length > 0) {
            paymentId = data.id;
            ref = data.provider_ref ?? "";
          } else await new Promise((r) => setTimeout(r, 50));
        }
        expect(paymentId).not.toBe("");
        const aborted = res(await abortPayment(deps, { paymentId }));
        expect(aborted.status).toBe("abort_failed");
        const { data: events } = await admin
          .from("payment_event")
          .select("payload")
          .eq("payment_id", paymentId)
          .eq("kind", "abort");
        expect(events).toHaveLength(1);
        const stored = JSON.stringify(events![0]!.payload);
        expect(stored).not.toContain("SECRET-AUTHKEY-1");
        expect(stored).toContain("[redacted]");
        // release the held sale (the next abort succeeds) so its request settles
        await fake.abort({ terminal: { secret: "" }, ref });
        expect(res(await sale).payment.state).toBe("cancelled");
      } finally {
        await dropOrg(org);
      }
    });
  },
);
