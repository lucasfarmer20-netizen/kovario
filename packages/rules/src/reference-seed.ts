// Per-org reference rows (docs/02-DOMAIN-MODEL.md §3), built from the processing-rules
// seed. Onboarding passes this payload to public.create_org, which inserts it verbatim, so
// SQL never re-states species, matrices or yield factors. Keys match the table columns.
import { CONDITION_CODES, CONDITIONS } from "./conditions.ts";
import { METHOD_CODES, METHODS } from "./methods.ts";
import { SEED } from "./seed.ts";
import { SPECIES, SPECIES_CODES, type SpeciesGroup } from "./species.ts";

export interface SpeciesSeedRow {
  code: string;
  name: string;
  group: SpeciesGroup;
  shorthand: string;
  skin_off_allowed: boolean;
  skin_off_multiplier: number;
  sort: number;
  is_active: boolean;
}

export interface ConditionSeedRow {
  code: string;
  name: string;
  sort: number;
  is_active: boolean;
}

export interface MethodSeedRow {
  code: string;
  name: string;
  shorthand: string | null;
  kind: "service" | "virtual";
  is_exchange: boolean;
  lodge_cappable: boolean;
  sort: number;
  is_active: boolean;
}

export interface ReferenceSeed {
  species: SpeciesSeedRow[];
  conditions: ConditionSeedRow[];
  methods: MethodSeedRow[];
  condition_matrix: { matrix_key: string; condition_code: string }[];
  processing_matrix: { matrix_key: string; condition_code: string; method_code: string }[];
  yield_factors: {
    species_code: string;
    condition_code: string;
    method_code: string;
    factor: number;
  }[];
}

/** Rate-card keys that are not method codes (docs/02-DOMAIN-MODEL.md §3 `rate_card`). */
export const RATE_CARD_EXTRA_KEYS = [
  "ribbing_per_lb",
  "fast_pass_per_lb",
  "storage_per_box_day",
] as const;

export function referenceSeed(): ReferenceSeed {
  return {
    species: SPECIES_CODES.map((code) => {
      const s = SPECIES[code];
      return {
        code,
        name: s.name,
        group: s.group,
        shorthand: s.shorthand,
        skin_off_allowed: s.skinOffAllowed,
        skin_off_multiplier: s.skinOffMultiplier,
        sort: s.sort,
        is_active: true,
      };
    }),
    conditions: CONDITION_CODES.map((code) => ({
      code,
      name: CONDITIONS[code].name,
      sort: CONDITIONS[code].sort,
      is_active: true,
    })),
    methods: METHOD_CODES.map((code) => {
      const m = METHODS[code];
      return {
        code,
        name: m.name,
        shorthand: m.shorthand,
        kind: m.kind,
        is_exchange: m.isExchange,
        lodge_cappable: m.lodgeCappable,
        sort: m.sort,
        is_active: m.isActive,
      };
    }),
    condition_matrix: Object.entries(SEED.condition_matrix).flatMap(([matrix_key, codes]) =>
      codes.map((condition_code) => ({ matrix_key, condition_code })),
    ),
    processing_matrix: Object.entries(SEED.processing_matrix).flatMap(([key, methods]) => {
      const [matrix_key = "", condition_code = ""] = key.split("|");
      return methods.map((method_code) => ({ matrix_key, condition_code, method_code }));
    }),
    yield_factors: SEED.yield_table.map((r) => ({
      species_code: r.species,
      condition_code: r.condition,
      method_code: r.processing,
      factor: r.factor,
    })),
  };
}
