import { describe, expect, it } from "vitest";
import { formatCarrierAllowlist, parseCarrierAllowlist, settingsFromForm } from "./org-settings";

function form(over: Record<string, string | null> = {}): FormData {
  const base: Record<string, string | null> = {
    hold_hours: "48",
    estimated_pickup_days: "3",
    wave_target_lb: "4000",
    wave_tolerance_lb: "250",
    receipt_footer: "",
    status_page_enabled: "on",
    tax_rate_pct: "6",
    tax_cap_amount: "30",
    carrier_allowlist: "*",
    buy_window_days: "1",
    tag_digits: "3",
    variance_hold_pct: "15",
  };
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) fd.set(k, v);
  return fd;
}

describe("settingsFromForm (/admin/settings)", () => {
  it("WP20 pickup hours and rates notice round-trip through settings", () => {
    expect(
      settingsFromForm(form({ pickup_hours: "9–5", rates_notice: "Final services apply" })),
    ).toMatchObject({ settings: { pickup_hours: "9–5", rates_notice: "Final services apply" } });
    expect(settingsFromForm(form({ pickup_hours: "x".repeat(501) }))).toHaveProperty("error");
  });
  it("builds exactly the docs §12 default object from the default form", () => {
    expect(settingsFromForm(form())).toEqual({
      settings: {
        hold_hours: 48,
        estimated_pickup_days: 3,
        wave_target_lb: 4000,
        wave_tolerance_lb: 250,
        receipt_footer: "",
        status_page_enabled: true,
        tax: { mode: "exclusive", rate: 0.06, cap_amount: 30 },
        shipping: { carrier_allowlist: "*", buy_window_days: 1 },
        scanner: { tag_digits: 3 },
        reconcile: { variance_hold_pct: 15 },
      },
    });
  });

  it("an unchecked checkbox is false; an empty cap means no cap", () => {
    const r = settingsFromForm(form({ status_page_enabled: null, tax_cap_amount: "" }));
    expect(r).toMatchObject({
      settings: { status_page_enabled: false, tax: { cap_amount: null } },
    });
  });

  it("percent → fraction without float noise", () => {
    expect(settingsFromForm(form({ tax_rate_pct: "7" }))).toMatchObject({
      settings: { tax: { rate: 0.07 } },
    });
    expect(settingsFromForm(form({ tax_rate_pct: "5.75" }))).toMatchObject({
      settings: { tax: { rate: 0.0575 } },
    });
  });

  it("rejects out-of-range values and a tolerance above the target", () => {
    expect(settingsFromForm(form({ hold_hours: "0" }))).toHaveProperty("error");
    expect(settingsFromForm(form({ hold_hours: "1.5" }))).toHaveProperty("error");
    expect(settingsFromForm(form({ tax_rate_pct: "60" }))).toHaveProperty("error");
    for (const pct of ["0", "101", "12.5", ""])
      expect(settingsFromForm(form({ variance_hold_pct: pct }))).toEqual({
        error: "Check variance hold pct.",
      });
    expect(settingsFromForm(form({ variance_hold_pct: "20" }))).toMatchObject({
      settings: { reconcile: { variance_hold_pct: 20 } },
    });
    expect(settingsFromForm(form({ wave_tolerance_lb: "5000" }))).toEqual({
      error: "The wave tolerance cannot exceed the wave target.",
    });
  });
});

describe("carrier allowlist", () => {
  it("* or empty means all carriers", () => {
    expect(parseCarrierAllowlist("*")).toBe("*");
    expect(parseCarrierAllowlist("  ")).toBe("*");
    expect(parseCarrierAllowlist("usps, *")).toBe("*");
  });
  it("normalises a list and rejects junk", () => {
    expect(parseCarrierAllowlist("USPS, fedex, usps")).toEqual(["usps", "fedex"]);
    expect(parseCarrierAllowlist("ups; fedex")).toBeNull();
    expect(formatCarrierAllowlist(["usps", "fedex"])).toBe("usps, fedex");
    expect(formatCarrierAllowlist("*")).toBe("*");
  });
});
