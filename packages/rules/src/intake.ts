// Intake draft (docs/04-BUSINESS-RULES.md §1–§2, docs/06-STATIONS-UX.md Intake): the rules
// engine output for an intake's lines — yield snapshot per line, charge drafts, and the
// priced preview the station's live price panel shows. `savePayload` is what the station
// sends to `save_intake`; the database prices the drafts itself from the snapshotted rate
// card with the same rule (app.price_per_lb, generated from pricing.ts by rules-sql.ts), so
// a client never supplies a price.
import {
  expandLines,
  hasRibbing,
  type ChargeDraft,
  type IntakeLineInput,
  type RateKey,
} from "./charges.ts";
import { FRESH } from "./methods.ts";
import { round } from "./num.ts";
import { RIBBING_ITEM, pricePerLb } from "./pricing.ts";
import { estimatedYieldLb, yieldFactor } from "./yield.ts";

/** `charge.qty` / `amount` are stored to 2 dp (numeric(10,2) / numeric(12,2)). */
export const MONEY_DP = 2;
export const CHARGE_QTY_DP = 2;

export interface IntakeLine extends IntakeLineInput {
  notes?: string | null;
}

export interface DraftLine extends IntakeLine {
  /** Snapshot written to `intake_line.yield_factor`; `null` when the seed has no factor. */
  yieldFactor: number | null;
  estYieldLb: number | null;
}

export interface IntakePricing {
  /** Rate-card amounts by key: service method codes, `ribbing_per_lb`, `fast_pass_per_lb`. */
  rates: Readonly<Record<string, number>>;
  fastPass: boolean;
  isLodgeGuest: boolean;
  /** `lodge.pricing_cap`; `null` = no cap. */
  lodgeCap: number | null;
  /** Org `processing_method.lodge_cappable` by code; a missing code uses the seed default. */
  lodgeCappable?: Readonly<Record<string, boolean>>;
}

export interface PricedCharge extends ChargeDraft {
  /** `null` when the rate card has no rate for `rateKey` (or Fast Pass has no floor). */
  unitPrice: number | null;
  amount: number | null;
}

export interface IntakeDraft {
  lines: DraftLine[];
  charges: PricedCharge[];
  ribbing: boolean;
  totalLb: number;
  totalEstYieldLb: number;
  /** `null` while any charge is unpriced (see `missingRates`). */
  totalAmount: number | null;
  missingRates: string[];
}

export const FAST_PASS_RATE_KEY = "fast_pass_per_lb";

function draftLine(line: IntakeLine): DraftLine {
  const factor = yieldFactor({
    species: line.species,
    condition: line.condition,
    method: line.method,
    skinOff: line.skinOff ?? false,
    filletsPct: line.method === FRESH ? line.filletsPct : null,
  });
  return {
    ...line,
    yieldFactor: factor,
    estYieldLb: factor === null ? null : estimatedYieldLb(line.lb, factor),
  };
}

function rate(rates: IntakePricing["rates"], key: string): number | null {
  const value = rates[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function priceCharge(charge: ChargeDraft, pricing: IntakePricing, missing: Set<string>) {
  const listPrice = rate(pricing.rates, charge.rateKey);
  const fastPassRate = rate(pricing.rates, FAST_PASS_RATE_KEY);
  if (listPrice === null) missing.add(charge.rateKey);
  if (charge.kind === "processing" && pricing.fastPass && fastPassRate === null) {
    missing.add(FAST_PASS_RATE_KEY);
  }
  if (
    listPrice === null ||
    (charge.kind === "processing" && pricing.fastPass && fastPassRate === null)
  ) {
    return { unitPrice: null, amount: null };
  }
  const method = charge.method;
  const unitPrice = pricePerLb({
    method: charge.kind === "ribbing" || method === null ? RIBBING_ITEM : method,
    listPrice,
    fastPassRate,
    lodgeCap: pricing.lodgeCap,
    isLodgeGuest: pricing.isLodgeGuest,
    fastPass: pricing.fastPass,
    lodgeCappable: method === null ? undefined : pricing.lodgeCappable?.[method],
  });
  // Mirrors charge.amount = round(qty × unit_price, 2) on the stored (2 dp) qty.
  return { unitPrice, amount: round(round(charge.qty, CHARGE_QTY_DP) * unitPrice, MONEY_DP) };
}

/**
 * Yield snapshot, charge drafts and the priced preview for an intake's lines. Throws
 * `RangeError` on a line the matrices do not allow.
 */
export function buildIntakeDraft(
  lines: readonly IntakeLine[],
  pricing: IntakePricing,
): IntakeDraft {
  const drafted = lines.map(draftLine);
  const missing = new Set<string>();
  const charges = expandLines(lines).map((c) => ({ ...c, ...priceCharge(c, pricing, missing) }));
  const unpriced = charges.some((c) => c.amount === null);
  return {
    lines: drafted,
    charges,
    ribbing: hasRibbing(lines),
    totalLb: round(
      drafted.reduce((s, l) => s + l.lb, 0),
      CHARGE_QTY_DP,
    ),
    totalEstYieldLb: round(
      drafted.reduce((s, l) => s + (l.estYieldLb ?? 0), 0),
      CHARGE_QTY_DP,
    ),
    totalAmount: unpriced
      ? null
      : round(
          charges.reduce((s, c) => s + (c.amount ?? 0), 0),
          MONEY_DP,
        ),
    missingRates: [...missing].sort(),
  };
}

export interface IntakeHeader {
  /** Set when re-saving an unlocked intake. */
  intakeId?: string | null;
  customerId: string;
  siteId?: string | null;
  toteCount: number;
  dirtyFish: boolean;
  dirtyNotes?: string | null;
  cutNotes?: string | null;
  processingNotes?: string | null;
  fastPass: boolean;
  /** Also queue an intake receipt print job. */
  printReceipt?: boolean;
}

/** The `save_intake(p_client_action_id, p_payload)` payload (snake_case JSON). */
export interface SaveIntakePayload {
  intake_id: string | null;
  customer_id: string;
  site_id: string | null;
  tote_count: number;
  dirty_fish: boolean;
  dirty_notes: string | null;
  cut_notes: string | null;
  processing_notes: string | null;
  fast_pass: boolean;
  print_receipt: boolean;
  lines: {
    species_code: string;
    condition_code: string;
    method_code: string;
    lb: number;
    fillets_pct: number | null;
    skin_off: boolean;
    yield_factor: number | null;
    notes: string | null;
  }[];
  charges: {
    kind: ChargeDraft["kind"];
    line_index: number;
    rate_key: RateKey;
    qty: number;
    description: string;
  }[];
}

function text(value: string | null | undefined): string | null {
  const t = value?.trim() ?? "";
  return t === "" ? null : t;
}

/**
 * Builds the save payload from the station form. Throws `RangeError` when there are no
 * lines, the tote count is not a positive integer, or a line breaks a rule.
 */
export function savePayload(header: IntakeHeader, lines: readonly IntakeLine[]): SaveIntakePayload {
  if (lines.length === 0) throw new RangeError("an intake needs at least one line");
  if (!Number.isSafeInteger(header.toteCount) || header.toteCount < 1) {
    throw new RangeError("tote count must be a whole number of at least 1");
  }
  const drafted = lines.map(draftLine);
  return {
    intake_id: header.intakeId ?? null,
    customer_id: header.customerId,
    site_id: header.siteId ?? null,
    tote_count: header.toteCount,
    dirty_fish: header.dirtyFish,
    dirty_notes: header.dirtyFish ? text(header.dirtyNotes) : null,
    cut_notes: text(header.cutNotes),
    processing_notes: text(header.processingNotes),
    fast_pass: header.fastPass,
    print_receipt: header.printReceipt ?? false,
    lines: drafted.map((l) => ({
      species_code: l.species,
      condition_code: l.condition,
      method_code: l.method,
      lb: l.lb,
      fillets_pct: l.method === FRESH ? (l.filletsPct ?? null) : null,
      skin_off: l.skinOff ?? false,
      yield_factor: l.yieldFactor,
      notes: text(l.notes),
    })),
    charges: expandLines(lines).map((c) => ({
      kind: c.kind,
      line_index: c.lineIndex,
      rate_key: c.rateKey,
      qty: c.qty,
      description: c.description,
    })),
  };
}
