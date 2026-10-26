// The processing-rules seed (docs/04-BUSINESS-RULES.md: "extracted verbatim from the CSP
// reference"). It is the single source for species, matrices and yield factors; the
// typed modules (species.ts, conditions.ts, methods.ts) check their code lists against it.
import raw from "../../../docs/seed/processing-rules.json" with { type: "json" };

export interface YieldRow {
  species: string;
  condition: string;
  processing: string;
  factor: number;
}

export interface ProcessingRulesSeed {
  species: Record<string, string[]>;
  species_shorthand: Record<string, string>;
  processing_shorthand: Record<string, string>;
  skin_off: {
    species: string[];
    multiplier: Record<string, number>;
    default_multiplier: number;
  };
  smoked_exchange_codes: string[];
  yield_table: YieldRow[];
  /** `"<matrix_key>|<condition>" → method codes`. */
  processing_matrix: Record<string, string[]>;
  /** `matrix_key → condition codes`. */
  condition_matrix: Record<string, string[]>;
}

export const SEED: ProcessingRulesSeed = raw;
