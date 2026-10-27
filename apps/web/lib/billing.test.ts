import { FunctionsHttpError } from "@supabase/supabase-js";
import type { FilletryClient } from "db";
import { describe, expect, it } from "vitest";
import { billingErrorMessage, billingRedirect } from "./billing";

function client(result: { data: unknown; error: unknown }) {
  const calls: { fn: string; body: unknown }[] = [];
  const fake = {
    functions: {
      invoke: async (fn: string, opts: { body: unknown }) => {
        calls.push({ fn, body: opts.body });
        return result;
      },
    },
  } as unknown as FilletryClient;
  return { fake, calls };
}

describe("billingRedirect (/admin/subscription → billing-* Edge Functions)", () => {
  it("returns the Stripe URL from the function", async () => {
    const { fake, calls } = client({
      data: { url: "https://checkout.stripe.test/x" },
      error: null,
    });
    const r = await billingRedirect(fake, "billing-checkout", { plan: "plant", return_url: "u" });
    expect(r).toEqual({ url: "https://checkout.stripe.test/x" });
    expect(calls).toEqual([{ fn: "billing-checkout", body: { plan: "plant", return_url: "u" } }]);
  });

  it("maps the function's error code to a message", async () => {
    const response = new Response(JSON.stringify({ error: "billing_not_configured" }), {
      status: 503,
    });
    const { fake } = client({ data: null, error: new FunctionsHttpError(response) });
    expect(await billingRedirect(fake, "billing-portal", { return_url: "u" })).toEqual({
      error: "Billing is not set up on this server yet (Stripe keys are missing).",
    });
  });

  it("falls back to a generic message", async () => {
    const { fake } = client({ data: {}, error: null });
    expect(await billingRedirect(fake, "billing-portal", { return_url: "u" })).toEqual({
      error: "Billing failed; try again.",
    });
    expect(billingErrorMessage("already_subscribed")).toMatch(/Manage billing/);
  });
});
