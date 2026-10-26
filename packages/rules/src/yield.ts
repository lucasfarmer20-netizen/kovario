// Yield (docs/04-BUSINESS-RULES.md §1): est_yield_lb = lb × yield_factor(species,
// condition, method), with fallbacks chum → reds and smoked-exchange → smoking, and the
// skin-off multiplier for whitefish + shark.
import type { ConditionCode } from "./conditions.ts";
import { FRESH, SMOKING, isExchangeMethod, type MethodCode } from "./methods.ts";
import { isNonNegativeFinite, round } from "./num.ts";
import { SEED } from "./seed.ts";
import { SPECIES, type SpeciesCode } from "./species.ts";

/** Factors are kept to 4 dp (seed factors are 3 dp; skin-off multipliers add one more). */
export const FACTOR_DP = 4;
export const LB_DP = 3;

const TABLE: ReadonlyMap<string, number> = new Map(
  SEED.yield_table.map((r) => [`${r.species}|${r.condition}|${r.processing}`, r.factor]),
);

export interface YieldInput {
  species: SpeciesCode;
  condition: ConditionCode;
  method: MethodCode;
  skinOff?: boolean;
  /** Required for the virtual `fresh` method: share (0–100) that becomes fillets. */
  filletsPct?: number | null;
}

/**
 * The seeded factor for a concrete method, applying the fallbacks in order: exact row,
 * chum → reds, exchange → smoking, then both. `null` when the seed has no row at all.
 */
export function seedYieldFactor(
  species: SpeciesCode,
  condition: ConditionCode,
  method: MethodCode,
): number | null {
  const speciesTry: SpeciesCode[] =
    species === "salmon_chum" ? [species, "salmon_reds"] : [species];
  const methodTry: MethodCode[] = isExchangeMethod(method) ? [method, SMOKING] : [method];
  for (const m of methodTry) {
    for (const s of speciesTry) {
      const factor = TABLE.get(`${s}|${condition}|${m}`);
      if (factor !== undefined) return factor;
    }
  }
  return null;
}

function freshFactor(input: YieldInput): number | null {
  const pct = input.filletsPct;
  if (pct === null || pct === undefined || !(pct >= 0 && pct <= 100)) {
    throw new RangeError("fresh requires filletsPct between 0 and 100");
  }
  let weighted = 0;
  for (const [method, share] of [
    ["fillets", pct],
    ["portions", 100 - pct],
  ] as const) {
    if (share === 0) continue;
    const factor = seedYieldFactor(input.species, input.condition, method);
    if (factor === null) return null;
    weighted += factor * share;
  }
  return weighted / 100;
}

/**
 * The line's yield factor. For `fresh` it is the fillets/portions factors weighted by
 * `filletsPct`. Skin-off multiplies by the species' multiplier and is rejected for species
 * that do not allow it. `null` when the seed has no factor for the combination.
 */
export function yieldFactor(input: YieldInput): number | null {
  const species = SPECIES[input.species];
  if (input.skinOff && !species.skinOffAllowed) {
    throw new RangeError(`skin-off is not allowed for ${input.species}`);
  }
  const base =
    input.method === FRESH
      ? freshFactor(input)
      : seedYieldFactor(input.species, input.condition, input.method);
  if (base === null) return null;
  return round(input.skinOff ? base * species.skinOffMultiplier : base, FACTOR_DP);
}

/** `est_yield_lb = lb × factor`. */
export function estimatedYieldLb(lb: number, factor: number): number {
  if (!isNonNegativeFinite(lb) || !isNonNegativeFinite(factor)) {
    throw new RangeError("lb and factor must be finite and >= 0");
  }
  return round(lb * factor, LB_DP);
}

/** Reconcile variance `(actual − expected) / expected × 100`; `null` when nothing was expected. */
export function yieldVariancePct(actualLb: number, expectedLb: number): number | null {
  if (expectedLb === 0) return null;
  return round(((actualLb - expectedLb) / expectedLb) * 100, 2);
}
