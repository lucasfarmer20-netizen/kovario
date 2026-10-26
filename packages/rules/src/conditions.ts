// Incoming-condition reference data (docs/02-DOMAIN-MODEL.md §3 `incoming_condition`).

export const CONDITION_CODES = [
  "whole",
  "hg",
  "headed",
  "gutted",
  "filleted",
  "filleted_ribs",
  "as_is",
  "tails_only",
  "portions",
  "vs",
  "vsf",
  "vsr",
] as const;
export type ConditionCode = (typeof CONDITION_CODES)[number];

export interface Condition {
  code: ConditionCode;
  name: string;
  sort: number;
}

const NAMES: Record<ConditionCode, string> = {
  whole: "Whole",
  hg: "Headed & gutted",
  headed: "Headed",
  gutted: "Gutted",
  filleted: "Filleted",
  filleted_ribs: "Filleted (ribs in)",
  as_is: "As-is",
  tails_only: "Tails only",
  portions: "Portions",
  // vs = customer-packed, temperature unknown; processed As-is (04-BUSINESS-RULES §1).
  vs: "Vacuum sealed",
  vsf: "Vacuum sealed frozen",
  vsr: "Vacuum sealed refrigerated",
};

/** Lines in this condition carry a ribbing charge (04-BUSINESS-RULES §1 Ribbing). */
export const RIBBING_CONDITION: ConditionCode = "filleted_ribs";

export function isConditionCode(value: string): value is ConditionCode {
  return (CONDITION_CODES as readonly string[]).includes(value);
}

export const CONDITIONS: Readonly<Record<ConditionCode, Condition>> = Object.fromEntries(
  CONDITION_CODES.map((code, i): [ConditionCode, Condition] => [
    code,
    { code, name: NAMES[code], sort: (i + 1) * 10 },
  ]),
) as Record<ConditionCode, Condition>;
