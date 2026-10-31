import { isSpeciesCode, SPECIES } from "rules";

/** "Reds" for salmon_reds; an unknown code as is (Reconcile, Wave, Rollstock). */
export function speciesName(code: string): string {
  return isSpeciesCode(code) ? SPECIES[code].name : code;
}
