import type { FilletryClient } from "db";
import { FakeProvider } from "payments";
import { describe, expect, it, vi } from "vitest";
import * as abortRoute from "@/app/api/payments/abort/route";
import * as refundRoute from "@/app/api/payments/refund/route";
import * as reverseRoute from "@/app/api/payments/reverse/route";
import * as saleRoute from "@/app/api/payments/sale/route";
import * as statusRoute from "@/app/api/payments/status/route";
import { paymentInput, paymentsRoute, refundInput, saleInput, type MakeDeps } from "./http";
import { PaymentRequestError } from "./service";

const deps: MakeDeps = () =>
  Promise.resolve({
    caller: {} as FilletryClient,
    service: {} as FilletryClient,
    providerFor: () => new FakeProvider(),
  });

const post = (body: unknown) =>
  new Request("http://localhost/api/payments/x", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const PAYMENT_ID = "6f1d3c1e-0000-4000-8000-000000000001";

describe("/api/payments/* route config (docs/05 §1, DECISION-18)", () => {
  it.each([
    ["sale", saleRoute],
    ["abort", abortRoute],
    ["status", statusRoute],
    ["reverse", reverseRoute],
    ["refund", refundRoute],
  ])("%s runs on the Node runtime with maxDuration 300 (never Edge)", (_name, route) => {
    expect(route.runtime).toBe("nodejs");
    expect(route.maxDuration).toBe(300);
    expect(typeof route.POST).toBe("function");
  });
});

describe("paymentsRoute", () => {
  it("passes the validated body to the handler and returns its JSON", async () => {
    const run = vi.fn(() => Promise.resolve({ status: "applied" }));
    const res = await paymentsRoute(paymentInput, run, deps)(post({ paymentId: PAYMENT_ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "applied" });
    expect(run).toHaveBeenCalledWith(expect.anything(), { paymentId: PAYMENT_ID });
  });

  it("400 for a non-JSON body or a body that fails validation; the handler never runs", async () => {
    const run = vi.fn(() => Promise.resolve(null));
    const route = paymentsRoute(saleInput, run, deps);
    expect((await route(post("not json"))).status).toBe(400);
    const bad = await route(
      post({ clientActionId: "short", orderId: "x", amount: -1, tender: "gold" }),
    );
    expect(bad.status).toBe(400);
    expect(Object.keys(((await bad.json()) as { issues: object }).issues)).toEqual(
      expect.arrayContaining(["clientActionId", "orderId", "amount", "tender"]),
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("a refund needs a reason and a positive amount", () => {
    const base = { clientActionId: "rf-123456789", paymentId: PAYMENT_ID };
    expect(refundInput.safeParse({ ...base, reason: "x", amount: 0 }).success).toBe(false);
    expect(refundInput.safeParse({ ...base, reason: " ", amount: 1 }).success).toBe(false);
    expect(refundInput.safeParse({ ...base, reason: "wrong card", amount: 1 }).success).toBe(true);
  });

  it("maps PaymentRequestError to its status with the message", async () => {
    const run = () =>
      Promise.reject(new PaymentRequestError("PAY-0001 is still indeterminate", 409, "55000"));
    const res = await paymentsRoute(paymentInput, run, deps)(post({ paymentId: PAYMENT_ID }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "PAY-0001 is still indeterminate", code: "55000" });
  });

  it("an unexpected failure is a 500 that never echoes internals", async () => {
    const run = () => Promise.reject(new Error("Authkey=SECRET leaked in a stack"));
    const res = await paymentsRoute(paymentInput, run, deps)(post({ paymentId: PAYMENT_ID }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("SECRET");
  });

  it("an unauthenticated caller gets the deps error (401)", async () => {
    const noSession: MakeDeps = () => Promise.reject(new PaymentRequestError("Sign in first", 401));
    const res = await paymentsRoute(
      paymentInput,
      () => Promise.resolve(null),
      noSession,
    )(post({ paymentId: PAYMENT_ID }));
    expect(res.status).toBe(401);
  });
});
