// Intake lines → charge drafts (docs/02-DOMAIN-MODEL.md §4 `charge`,
// docs/04-BUSINESS-RULES.md §1): one processing charge per line method (fresh → fillets +
// portions) plus one ribbing charge per `filleted_ribs` line. Prices come from pricing.ts.
import { CONDITIONS, RIBBING_CONDITION, type ConditionCode } from "./conditions.ts";
import { isAllowed } from "./matrix.ts";
import { FRESH, FRESH_SPLIT, METHODS, type MethodCode, type ServiceMethodCode } from "./methods.ts";
import { isNonNegativeFinite, round } from "./num.ts";
import { SPECIES, type SpeciesCode } from "./species.ts";
import { LB_DP } from "./yield.ts";

export const CHARGE_KINDS = [
  "processing",
  "ribbing",
  "storage",
  "box_fee",
  "freight",
  "retail",
  "adjustment",
] as const;
export type ChargeKind = (typeof CHARGE_KINDS)[number];

export const CHARGE_STATES = ["open", "settled", "voided", "comped"] as const;
export type ChargeState = (typeof CHARGE_STATES)[number];

export interface IntakeLineInput {
  species: SpeciesCode;
  condition: ConditionCode;
  method: MethodCode;
  lb: number;
  /** Salmon + fresh only: share (0–100) that becomes fillets; portions get the rest. */
  filletsPct?: number | null;
  skinOff?: boolean;
}

export type RateKey = ServiceMethodCode | "ribbing_per_lb";

export interface ChargeDraft {
  kind: "processing" | "ribbing";
  /** Index of the source line in the input array. */
  lineIndex: number;
  /** Concrete method charged (`null` for ribbing). */
  method: ServiceMethodCode | null;
  /** Rate-card key the unit price comes from. */
  rateKey: RateKey;
  qty: number;
  unit: "lb";
  description: string;
}

export function hasRibbing(lines: readonly Pick<IntakeLineInput, "condition">[]): boolean {
  return lines.some((l) => l.condition === RIBBING_CONDITION);
}

function processing(
  line: IntakeLineInput,
  lineIndex: number,
  method: ServiceMethodCode,
  qty: number,
): ChargeDraft {
  const desc = `${SPECIES[line.species].name} ${CONDITIONS[line.condition].name} — ${METHODS[method].name}`;
  return {
    kind: "processing",
    lineIndex,
    method,
    rateKey: method,
    qty,
    unit: "lb",
    description: desc,
  };
}

function expandLine(line: IntakeLineInput, lineIndex: number): ChargeDraft[] {
  const where = `line ${lineIndex}`;
  if (!isNonNegativeFinite(line.lb)) throw new RangeError(`${where}: lb must be finite and >= 0`);
  if (!isAllowed(line.species, line.condition, line.method)) {
    throw new RangeError(
      `${where}: ${line.method} is not allowed for ${line.species} ${line.condition}`,
    );
  }
  const pct = line.filletsPct ?? null;
  const out: ChargeDraft[] = [];
  if (line.method === FRESH) {
    if (pct === null || !(pct >= 0 && pct <= 100)) {
      throw new RangeError(`${where}: fresh requires filletsPct between 0 and 100`);
    }
    const [fillets, portions] = FRESH_SPLIT;
    const filletsLb = round((line.lb * pct) / 100, LB_DP);
    // Fillets % = 0 → all portions (and 100 → all fillets): no zero-share charge.
    if (pct > 0) out.push(processing(line, lineIndex, fillets, filletsLb));
    if (pct < 100)
      out.push(processing(line, lineIndex, portions, round(line.lb - filletsLb, LB_DP)));
  } else {
    if (pct !== null) throw new RangeError(`${where}: filletsPct applies to fresh only`);
    out.push(processing(line, lineIndex, line.method, line.lb));
  }
  if (line.condition === RIBBING_CONDITION) {
    out.push({
      kind: "ribbing",
      lineIndex,
      method: null,
      rateKey: "ribbing_per_lb",
      qty: line.lb,
      unit: "lb",
      description: `Ribbing — ${SPECIES[line.species].name}`,
    });
  }
  return out;
}

/**
 * Charge drafts for an intake's lines, in line order. Throws on a line the matrices do
 * not allow — the rules engine is the authority, callers never re-check.
 */
export function expandLines(intakeLines: readonly IntakeLineInput[]): ChargeDraft[] {
  return intakeLines.flatMap(expandLine);
}
