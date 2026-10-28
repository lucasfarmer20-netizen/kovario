// Register tax (docs/04-BUSINESS-RULES.md §12, DECISION-07 default: compute, exclusive, cap
// supported). Org setting `tax: {mode, rate, cap_amount}`:
//   exclusive — tax = subtotal × rate, added on top;
//   inclusive — the subtotal already contains the tax: tax = subtotal × rate / (1 + rate);
//   none      — no tax.
// `cap_amount` is the most tax one transaction pays (6% on the first $500 → $30). The register
// order applies it through app.tax_amount / app.tax_total, generated from this file
// (register-sql.ts), so the cart, the charged amount and the receipt agree.

export const TAX_MODES = ["exclusive", "inclusive", "none"] as const;
export type TaxMode = (typeof TAX_MODES)[number];

export interface TaxSetting {
  mode: TaxMode;
  /** Fraction, 0 ≤ rate ≤ 1, at most 6 dp (0.06 = 6%). */
  rate: number;
  /** Most tax per transaction; null = uncapped. */
  cap_amount: number | null;
}

export interface TaxResult {
  subtotal: number;
  tax: number;
  total: number;
}

export const NO_TAX: TaxSetting = { mode: "none", rate: 0, cap_amount: null };

const MICRO = 1_000_000n;

function scaled(value: number, scale: number): bigint | null {
  if (!Number.isFinite(value)) return null;
  const x = value * scale;
  const whole = Math.round(x);
  return Math.abs(x - whole) < 1e-6 ? BigInt(whole) : null;
}

/**
 * The org's `settings.tax`, normalised. A missing or non-object setting is no tax; a setting
 * without a mode is exclusive (the documented default). Values are validated by computeTax.
 */
export function taxSetting(raw: unknown): TaxSetting {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return NO_TAX;
  const r = raw as Record<string, unknown>;
  const mode = (TAX_MODES as readonly unknown[]).includes(r.mode)
    ? (r.mode as TaxMode)
    : "exclusive";
  const rate = typeof r.rate === "number" ? r.rate : 0;
  const cap = typeof r.cap_amount === "number" ? r.cap_amount : null;
  return { mode, rate, cap_amount: cap };
}

/**
 * Tax on a register order's `subtotal` (the sum of its lines, in dollars, 2 dp). Whole cents,
 * integer arithmetic, half-up: no float drift, and app.tax_amount agrees on every input. A
 * subtotal ≤ 0 (a refund-only or fully comped cart) carries no tax.
 */
export function computeTax(setting: TaxSetting, subtotal: number): TaxResult {
  const s = scaled(subtotal, 100);
  if (s === null) throw new RangeError("subtotal must be an amount in cents");
  const rate = scaled(setting.rate, 1_000_000);
  if (rate === null || rate < 0n || rate > MICRO)
    throw new RangeError("tax rate must be between 0 and 1, at most 6 dp");
  const cap = setting.cap_amount === null ? null : scaled(setting.cap_amount, 100);
  if (setting.cap_amount !== null && (cap === null || cap < 0n)) {
    throw new RangeError("tax cap must be a non-negative amount in cents");
  }

  let tax = 0n;
  if (setting.mode !== "none" && s > 0n && rate > 0n) {
    // half-up of s·r / d, with d = 10⁶ (exclusive) or 10⁶ + r (inclusive)
    const d = setting.mode === "exclusive" ? MICRO : MICRO + rate;
    tax = (2n * s * rate + d) / (2n * d);
    if (cap !== null && tax > cap) tax = cap;
  }
  const total = setting.mode === "exclusive" ? s + tax : s;
  return { subtotal: Number(s) / 100, tax: Number(tax) / 100, total: Number(total) / 100 };
}
