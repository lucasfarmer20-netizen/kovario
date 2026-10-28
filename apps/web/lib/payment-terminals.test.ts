import { describe, expect, it } from "vitest";
import { parseStripeTerminalForm, stripeWebhookPath } from "./payment-terminals";

const base = { name: "Front", reader_id: "tmr_FbX1", secret_ref: "stripe_rk:front" };

describe("Stripe terminal config form (docs/05 §5)", () => {
  it("accepts reader id, location, Vault names and the active checkbox", () => {
    const r = parseStripeTerminalForm({
      ...base,
      location_id: "tml_Ab1",
      webhook_secret_ref: "stripe_whsec:front",
      is_active: "on",
    });
    expect(r).toEqual({
      ok: true,
      value: {
        ...base,
        location_id: "tml_Ab1",
        webhook_secret_ref: "stripe_whsec:front",
        is_active: "on",
      },
    });
    expect(parseStripeTerminalForm(base).ok).toBe(true);
  });

  it.each([
    ["a pasted restricted key", { secret_ref: "rk_live_51Habc" }, /NAME/],
    ["a pasted secret key", { secret_ref: "sk_test_51Habc" }, /NAME/],
    ["a pasted webhook secret", { webhook_secret_ref: "whsec_abc" }, /NAME/],
    ["no key name", { secret_ref: " " }, /restricted key/],
    ["a reader id that is not tmr_", { reader_id: "WisePOS-1" }, /tmr_/],
    ["a location that is not tml_", { location_id: "loc_1" }, /tml_/],
    ["no name", { name: "" }, /Name/],
  ])("refuses %s", (_label, over, message) => {
    const r = parseStripeTerminalForm({ ...base, ...over });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });

  it("the webhook URL is per terminal", () => {
    expect(stripeWebhookPath("t-1")).toBe("/api/payments/stripe/webhook/t-1");
  });
});
