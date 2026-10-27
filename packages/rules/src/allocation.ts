// Counter allocation (docs/04-BUSINESS-RULES.md §8): a session pools one or more intakes and
// splits the party's processing charges across its anglers by `weight` (proportional to each
// angler's take-home lb) or `even`. Each angler's settlement = processing share + box fees +
// freight. Box plans carry the 70-lb heavy check. The database applies the same split inside
// price_session through app.split_amount, generated from this file (allocation-sql.ts).

export const SPLIT_METHODS = ["weight", "even"] as const;
export type SplitMethod = (typeof SPLIT_METHODS)[number];

export const BOX_PLAN_METHODS = ["air", "ship", "willcall"] as const;
export type BoxPlanMethod = (typeof BOX_PLAN_METHODS)[number];

/** A box heavier than this needs an explicit heavy acknowledgement (`heavy_allowed`). */
export const HEAVY_BOX_LB = 70;

export const WEIGHT_SPLIT_NEEDS_LB =
  "a weight split needs take-home lb for at least one angler; enter lb or split evenly";

const CENTS = 100n;

/** `value` as an exact integer count of hundredths, or null when it has more decimals. */
function hundredths(value: number): bigint | null {
  if (!Number.isFinite(value)) return null;
  const scaled = value * 100;
  const whole = Math.round(scaled);
  return Math.abs(scaled - whole) < 1e-6 ? BigInt(whole) : null;
}

/**
 * THE penny rule. Splits `total` dollars across shares weighted by `weights` so the shares
 * sum to `total` exactly, to the cent:
 *
 * 1. Work in whole cents: T = total × 100; each weight in hundredths (lb are 2-dp).
 * 2. Exact share of share i: T × wᵢ / Σw. Every share first gets the floor of that, in cents.
 * 3. The cents left over (fewer than the number of shares) go one each to the shares with the
 *    largest remainders (largest-remainder / Hamilton method); a tie goes to the earlier share
 *    (the angler listed first, i.e. the lower settlement number).
 *
 * A zero weight gets 0. Integer arithmetic throughout, so no float drift; app.split_amount is
 * the SQL form and agrees on every input (packages/db allocation.db.test.ts).
 */
export function splitAmount(total: number, weights: readonly number[]): number[] {
  const t = hundredths(total);
  if (t === null || t < 0n) throw new RangeError("total must be a non-negative amount in cents");
  if (weights.length === 0) throw new RangeError("split needs at least one share");
  const w = weights.map((x) => {
    const h = hundredths(x);
    if (h === null || h < 0n) throw new RangeError("weights must be non-negative, at most 2 dp");
    return h;
  });
  const sum = w.reduce((a, b) => a + b, 0n);
  if (sum === 0n) throw new RangeError(WEIGHT_SPLIT_NEEDS_LB);

  const floors = w.map((x) => (t * x) / sum);
  const rems = w.map((x) => (t * x) % sum);
  let left = t - floors.reduce((a, b) => a + b, 0n);
  const order = rems
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of order) {
    if (left === 0n) break;
    floors[i]! += 1n;
    left -= 1n;
  }
  return floors.map((c) => Number(c) / Number(CENTS));
}

/** The split weights for a method: take-home lb per angler (`weight`), or 1 each (`even`). */
export function splitWeights(method: SplitMethod, anglerLb: readonly number[]): number[] {
  return method === "even" ? anglerLb.map(() => 1) : [...anglerLb];
}

export type BoxPlanIssue = "invalid_weight" | "heavy_unconfirmed";

/** Problems that block saving a box plan. Over 70 lb needs `heavyAllowed` (the heavy check). */
export function boxPlanIssues(box: { weightLb: number; heavyAllowed: boolean }): BoxPlanIssue[] {
  if (!Number.isFinite(box.weightLb) || box.weightLb < 0) return ["invalid_weight"];
  return isHeavy(box.weightLb) && !box.heavyAllowed ? ["heavy_unconfirmed"] : [];
}

export function isHeavy(weightLb: number): boolean {
  return weightLb > HEAVY_BOX_LB;
}

export type AnglerInput = {
  /** Take-home lb per species/method line. */
  speciesLb: readonly number[];
  /** Catalogue fee of each planned box's size. */
  boxFees: readonly number[];
  /** Freight placeholder carried on the settlement (0 until shipping quotes it, WP-19). */
  freight: number;
};

export type SettlementPrice = {
  weightTotalLb: number;
  processingShare: number;
  boxFeeTotal: number;
  freightTotal: number;
  amountTotal: number;
};

const sumCents = (xs: readonly number[]) => {
  let c = 0n;
  for (const x of xs) {
    const h = hundredths(x);
    if (h === null || h < 0n) throw new RangeError("amounts must be non-negative, at most 2 dp");
    c += h;
  }
  return c;
};
const dollars = (c: bigint) => Number(c) / Number(CENTS);

/**
 * Prices a session's settlements (what price_session writes): the pooled processing charges
 * split by the session's method, plus each angler's box fees and freight. Anglers in
 * settlement order (the penny tie-break order).
 */
export function priceSettlements(input: {
  pooledProcessing: number;
  method: SplitMethod;
  anglers: readonly AnglerInput[];
}): SettlementPrice[] {
  if (input.anglers.length === 0) throw new RangeError("a session needs at least one angler");
  const lb = input.anglers.map((a) => dollars(sumCents(a.speciesLb)));
  const shares = splitAmount(input.pooledProcessing, splitWeights(input.method, lb));
  return input.anglers.map((a, i) => {
    const boxFee = sumCents(a.boxFees);
    const freight = sumCents([a.freight]);
    const share = hundredths(shares[i]!)!;
    return {
      weightTotalLb: lb[i]!,
      processingShare: dollars(share),
      boxFeeTotal: dollars(boxFee),
      freightTotal: dollars(freight),
      amountTotal: dollars(share + boxFee + freight),
    };
  });
}
