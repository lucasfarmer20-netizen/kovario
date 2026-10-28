import { z } from "zod";

// org.settings (docs/02-DOMAIN-MODEL.md §12). public.admin_update_org re-validates the whole
// object (app.org_settings_problem); this module turns the settings form into that object.
// Money rates are not settings: they live on the rate card.

export type OrgSettings = {
  hold_hours: number;
  estimated_pickup_days: number;
  wave_target_lb: number;
  wave_tolerance_lb: number;
  receipt_footer: string;
  pickup_hours?: string;
  rates_notice?: string;
  status_page_enabled: boolean;
  tax: { mode: "exclusive"; rate: number; cap_amount: number | null };
  shipping: { carrier_allowlist: "*" | string[]; buy_window_days: number };
  scanner: { tag_digits: number };
};

const formSchema = z.object({
  hold_hours: z.coerce.number().int().min(1).max(720),
  estimated_pickup_days: z.coerce.number().int().min(0).max(60),
  wave_target_lb: z.coerce.number().min(1).max(100_000),
  wave_tolerance_lb: z.coerce.number().min(0).max(100_000),
  receipt_footer: z.string().max(500),
  pickup_hours: z.string().max(500).optional(),
  rates_notice: z.string().max(500).optional(),
  status_page_enabled: z.literal("on").optional(),
  // Entered as a percentage (6 = 6%); stored as a fraction.
  tax_rate_pct: z.coerce.number().min(0).max(50),
  tax_cap_amount: z.union([z.literal(""), z.coerce.number().min(0).max(100_000)]),
  carrier_allowlist: z.string().trim().max(400),
  buy_window_days: z.coerce.number().int().min(0).max(30),
  tag_digits: z.coerce.number().int().min(3).max(6),
});

const CARRIER = /^[a-z0-9_]{2,40}$/;

/** "*", "" → all carriers; "usps, FedEx" → ["usps", "fedex"]. */
export function parseCarrierAllowlist(raw: string): "*" | string[] | null {
  const tokens = raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0 || tokens.includes("*")) return "*";
  return tokens.every((t) => CARRIER.test(t)) ? [...new Set(tokens)] : null;
}

export function formatCarrierAllowlist(value: unknown): string {
  return Array.isArray(value) ? value.join(", ") : "*";
}

/** The settings object for admin_update_org, or a message for the form. */
export function settingsFromForm(form: FormData): { settings: OrgSettings } | { error: string } {
  const parsed = formSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join(".") ?? "settings";
    return { error: `Check ${field.replaceAll("_", " ")}.` };
  }
  const d = parsed.data;
  if (d.wave_tolerance_lb > d.wave_target_lb) {
    return { error: "The wave tolerance cannot exceed the wave target." };
  }
  const allowlist = parseCarrierAllowlist(d.carrier_allowlist);
  if (allowlist === null) {
    return { error: "Carriers: * for all, or a comma-separated list such as usps, fedex." };
  }
  return {
    settings: {
      hold_hours: d.hold_hours,
      estimated_pickup_days: d.estimated_pickup_days,
      wave_target_lb: d.wave_target_lb,
      wave_tolerance_lb: d.wave_tolerance_lb,
      receipt_footer: d.receipt_footer,
      ...(d.pickup_hours !== undefined ? { pickup_hours: d.pickup_hours } : {}),
      ...(d.rates_notice !== undefined ? { rates_notice: d.rates_notice } : {}),
      status_page_enabled: d.status_page_enabled === "on",
      tax: {
        mode: "exclusive",
        // 6 → 0.06 without float noise (0.07 * 100 style errors).
        rate: Math.round(d.tax_rate_pct * 1000) / 100_000,
        cap_amount: d.tax_cap_amount === "" ? null : d.tax_cap_amount,
      },
      shipping: { carrier_allowlist: allowlist, buy_window_days: d.buy_window_days },
      scanner: { tag_digits: d.tag_digits },
    },
  };
}
