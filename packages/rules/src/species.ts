// Species reference data (docs/02-DOMAIN-MODEL.md §3 `species`), typed from the seed.
import { SEED } from "./seed.ts";

export const SPECIES_GROUPS = ["salmon", "whitefish", "other", "byproduct"] as const;
export type SpeciesGroup = (typeof SPECIES_GROUPS)[number];

export const SPECIES_CODES = [
  "salmon_chum",
  "salmon_kings",
  "salmon_pinks",
  "salmon_reds",
  "salmon_silvers",
  "whitefish_cod",
  "whitefish_flounder",
  "whitefish_halibut",
  "whitefish_lingcod",
  "whitefish_rockfish",
  "whitefish_yelloweye",
  "byproduct_eggs",
  "byproduct_heads",
  "other_dolly",
  "other_octopus",
  "other_shark",
  "other_shrimp",
] as const;
export type SpeciesCode = (typeof SPECIES_CODES)[number];

export interface Species {
  code: SpeciesCode;
  name: string;
  group: SpeciesGroup;
  shorthand: string;
  skinOffAllowed: boolean;
  /** Applied to the yield factor when the line is skin-off (default 0.85). */
  skinOffMultiplier: number;
  sort: number;
}

/** `seed.species` keys → `species.group` (the seed says `salmonids`; the model says `salmon`). */
export const SEED_GROUP_KEYS: Readonly<Record<string, SpeciesGroup>> = {
  salmonids: "salmon",
  whitefish: "whitefish",
  other: "other",
  byproduct: "byproduct",
};

const NAMES: Record<SpeciesCode, string> = {
  salmon_chum: "Chum",
  salmon_kings: "Kings",
  salmon_pinks: "Pinks",
  salmon_reds: "Reds",
  salmon_silvers: "Silvers",
  whitefish_cod: "Cod",
  whitefish_flounder: "Flounder",
  whitefish_halibut: "Halibut",
  whitefish_lingcod: "Lingcod",
  whitefish_rockfish: "Rockfish",
  whitefish_yelloweye: "Yelloweye",
  byproduct_eggs: "Eggs",
  byproduct_heads: "Heads",
  other_dolly: "Dolly Varden",
  other_octopus: "Octopus",
  other_shark: "Shark",
  other_shrimp: "Shrimp",
};

export function isSpeciesCode(value: string): value is SpeciesCode {
  return (SPECIES_CODES as readonly string[]).includes(value);
}

function seedGroupOf(code: SpeciesCode): SpeciesGroup {
  for (const [key, codes] of Object.entries(SEED.species)) {
    const group = SEED_GROUP_KEYS[key];
    if (group && codes.includes(code)) return group;
  }
  throw new Error(`processing-rules seed has no group for species ${code}`);
}

export const SPECIES: Readonly<Record<SpeciesCode, Species>> = Object.fromEntries(
  SPECIES_CODES.map((code, i): [SpeciesCode, Species] => {
    const shorthand = SEED.species_shorthand[code];
    if (shorthand === undefined)
      throw new Error(`processing-rules seed has no shorthand for ${code}`);
    return [
      code,
      {
        code,
        name: NAMES[code],
        group: seedGroupOf(code),
        shorthand,
        skinOffAllowed: SEED.skin_off.species.includes(code),
        skinOffMultiplier: SEED.skin_off.multiplier[code] ?? SEED.skin_off.default_multiplier,
        sort: (i + 1) * 10,
      },
    ];
  }),
) as Record<SpeciesCode, Species>;
