// Condition and processing matrices (docs/04-BUSINESS-RULES.md §1). Matrix keys are a
// species code that overrides its group (`other_shark`, `other_shrimp`) or the group;
// lookup is species code first, then group.
import { isConditionCode, type ConditionCode } from "./conditions.ts";
import { isMethodCode, type MethodCode } from "./methods.ts";
import { SEED } from "./seed.ts";
import { SPECIES, isSpeciesCode, type SpeciesCode } from "./species.ts";

const EMPTY: readonly never[] = Object.freeze([]);

function matrixKeys(species: SpeciesCode): readonly string[] {
  return [species, SPECIES[species].group];
}

/** Conditions selectable for a species, in matrix order. Unknown species → `[]`. */
export function allowedConditions(speciesCode: string): readonly ConditionCode[] {
  if (!isSpeciesCode(speciesCode)) return EMPTY;
  for (const key of matrixKeys(speciesCode)) {
    const row = SEED.condition_matrix[key];
    if (row) return row.filter(isConditionCode);
  }
  return EMPTY;
}

/**
 * Methods selectable for a (species, condition), in matrix order. Includes the virtual
 * `fresh`; never includes `head_off` (manager add-on outside the matrix). A condition not
 * allowed for the species yields `[]`.
 */
export function allowedMethods(speciesCode: string, conditionCode: string): readonly MethodCode[] {
  if (!isSpeciesCode(speciesCode) || !isConditionCode(conditionCode)) return EMPTY;
  if (!allowedConditions(speciesCode).includes(conditionCode)) return EMPTY;
  for (const key of matrixKeys(speciesCode)) {
    const row = SEED.processing_matrix[`${key}|${conditionCode}`];
    if (row) return row.filter(isMethodCode);
  }
  return EMPTY;
}

export function isAllowed(speciesCode: string, conditionCode: string, methodCode: string): boolean {
  return (allowedMethods(speciesCode, conditionCode) as readonly string[]).includes(methodCode);
}
