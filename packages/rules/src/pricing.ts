// Pricing — ONE rule (docs/04-BUSINESS-RULES.md §2):
//
//   fast_pass      ? max(list_price, fast_pass_rate)   // floor; overrides cap
//   is_lodge_guest ? min(list_price, lodge_cap)        // lodge_cappable methods only
//   :                list_price
import type { ChargeKind, ChargeState } from "./charges.ts";
import { METHODS, type MethodCode } from "./methods.ts";
import { isNonNegativeFinite } from "./num.ts";

/** The ribbing rate (`ribbing_per_lb`): never capped or floored (DECISION-19). */
export const RIBBING_ITEM = "ribbing";

/** A method rate, or `ribbing` (`ribbing_per_lb`), which is never capped or floored. */
export type PricedItem = MethodCode | typeof RIBBING_ITEM;

export interface PriceInput {
  method: PricedItem;
  /** Rate-card price per lb for `method`, snapshotted on the intake. */
  listPrice: number;
  /** Rate-card `fast_pass_per_lb`; required when `fastPass`. */
  fastPassRate?: number | null;
  /** `lodge.pricing_cap`; `null` = no cap. */
  lodgeCap?: number | null;
  isLodgeGuest: boolean;
  fastPass: boolean;
  /** Org's `processing_method.lodge_cappable`; defaults to the seeded method flag. */
  lodgeCappable?: boolean;
}

function assertRate(name: string, value: number): void {
  if (!isNonNegativeFinite(value)) throw new RangeError(`${name} must be finite and >= 0`);
}

export function pricePerLb(input: PriceInput): number {
  const { method, listPrice } = input;
  assertRate("listPrice", listPrice);
  if (method === RIBBING_ITEM) return listPrice;
  if (input.fastPass) {
    const floor = input.fastPassRate;
    if (floor === null || floor === undefined) {
      throw new RangeError("fastPass requires fastPassRate (rate card fast_pass_per_lb)");
    }
    assertRate("fastPassRate", floor);
    return Math.max(listPrice, floor);
  }
  const cap = input.lodgeCap;
  const cappable = input.lodgeCappable ?? METHODS[method].lodgeCappable;
  if (input.isLodgeGuest && cappable && cap !== null && cap !== undefined) {
    assertRate("lodgeCap", cap);
    return Math.min(listPrice, cap);
  }
  return listPrice;
}

export interface RepriceCharge {
  kind: ChargeKind;
  state: ChargeState;
  settledPaymentId?: string | null;
}

export interface RepriceIntake {
  fastPass: boolean;
}

/**
 * Whether a lodge-guest flip may reprice this charge: only open, unpaid processing charges
 * on non-Fast-Pass intakes. Fast Pass is never repriced; ribbing is never capped.
 */
export function repriceEligible(charge: RepriceCharge, intake: RepriceIntake): boolean {
  return (
    charge.kind === "processing" &&
    charge.state === "open" &&
    (charge.settledPaymentId ?? null) === null &&
    !intake.fastPass
  );
}
