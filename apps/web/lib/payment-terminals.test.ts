import { describe, expect, it } from "vitest";
import {
  parseStripeTerminalForm,
  secretNameField,
  stripeWebhookPath,
  terminalSecretRef,
} from "./payment-terminals";

const base = { name: "Front", reader_id: "tmr_FbX1", secret_name: "stripe-rk" };
const ORG = "0a000000-0000-4000-8000-000000000001";

describe("Stripe terminal config form (docs/05 §5)", () => {
  it("accepts reader id, location, Vault secret names and the active checkbox", () => {
    const r = parseStripeTerminalForm({
      ...base,
      location_id: "tml_Ab1",
      webhook_secret_name: "Stripe-Whsec",
      is_active: "on",
    });
    expect(r).toEqual({
      ok: true,
      value: {
        ...base,
        location_id: "tml_Ab1",
        webhook_secret_name: "stripe-whsec",
        is_active: "on",
      },
    });
    expect(parseStripeTerminalForm(base).ok).toBe(true);
  });

  it.each([
    ["a pasted restricted key", { secret_name: "rk_live_51habc" }, /NAME/],
    ["a pasted secret key", { secret_name: "sk_test_51habc" }, /NAME/],
    ["a pasted webhook secret", { webhook_secret_name: "whsec_abc" }, /NAME/],
    [
      "a full Vault name (the server adds the prefix)",
      { secret_name: "terminal:x:rk" },
      /lowercase/,
    ],
    ["no key name", { secret_name: " " }, /restricted key/],
    ["a reader id that is not tmr_", { reader_id: "WisePOS-1" }, /tmr_/],
    ["a location that is not tml_", { location_id: "loc_1" }, /tml_/],
    ["no name", { name: "" }, /Name/],
  ])("refuses %s", (_label, over, message) => {
    const r = parseStripeTerminalForm({ ...base, ...over });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });

  it("secret names are scoped to the org (WP-17's terminal:<org id>:<name>)", () => {
    expect(terminalSecretRef(ORG, "stripe-rk")).toBe(`terminal:${ORG}:stripe-rk`);
    expect(terminalSecretRef(ORG, "")).toBe("");
    expect(secretNameField(ORG, `terminal:${ORG}:stripe-rk`)).toBe("stripe-rk");
    // another org's (or an unscoped) name is never shown as this org's
    expect(secretNameField(ORG, "terminal:0b000000-0000-4000-8000-000000000001:rk")).toBe("");
    expect(secretNameField(ORG, null)).toBe("");
  });

  it("the webhook URL is per terminal", () => {
    expect(stripeWebhookPath("t-1")).toBe("/api/payments/stripe/webhook/t-1");
  });
});
