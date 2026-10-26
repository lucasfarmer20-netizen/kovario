import { describe, expect, it } from "vitest";
import { CONDITION_CODES, CONDITIONS, isConditionCode } from "./conditions.ts";
import { METHOD_CODES, METHODS, isMethodCode } from "./methods.ts";
import { round } from "./num.ts";
import { SEED } from "./seed.ts";
import { SEED_GROUP_KEYS, SPECIES, SPECIES_CODES, isSpeciesCode } from "./species.ts";

// The typed code lists must match the seed exactly, so TS and the DB seed cannot drift.
describe("reference data is typed from the seed", () => {
  it("species codes are exactly the seed's species", () => {
    const seeded = Object.values(SEED.species).flat().sort();
    expect([...SPECIES_CODES].sort()).toEqual(seeded);
    expect(Object.keys(SEED.species).every((k) => k in SEED_GROUP_KEYS)).toBe(true);
  });

  it("maps seed group `salmonids` to group `salmon`", () => {
    expect(SPECIES.salmon_reds.group).toBe("salmon");
    expect(SPECIES.whitefish_halibut.group).toBe("whitefish");
    expect(SPECIES.other_shark.group).toBe("other");
    expect(SPECIES.byproduct_eggs.group).toBe("byproduct");
  });

  it("every condition and method code in the seed is a typed code", () => {
    const conditions = new Set<string>([
      ...Object.values(SEED.condition_matrix).flat(),
      ...Object.keys(SEED.processing_matrix).map((k) => k.split("|")[1] ?? ""),
      ...SEED.yield_table.map((r) => r.condition),
    ]);
    const methods = new Set<string>([
      ...Object.values(SEED.processing_matrix).flat(),
      ...SEED.yield_table.map((r) => r.processing),
      ...Object.keys(SEED.processing_shorthand),
    ]);
    expect([...conditions].filter((c) => !isConditionCode(c))).toEqual([]);
    expect([...methods].filter((m) => !isMethodCode(m))).toEqual([]);
    expect(SEED.yield_table.every((r) => isSpeciesCode(r.species))).toBe(true);
  });

  it("matrix keys are species groups or species codes", () => {
    const keys = [
      ...Object.keys(SEED.condition_matrix),
      ...Object.keys(SEED.processing_matrix).map((k) => k.split("|")[0] ?? ""),
    ];
    const groups = new Set(Object.values(SEED_GROUP_KEYS));
    expect(keys.filter((k) => !groups.has(k as never) && !isSpeciesCode(k))).toEqual([]);
  });

  it("skin-off: whitefish + shark only, with rockfish/lingcod multipliers", () => {
    const allowed = SPECIES_CODES.filter((c) => SPECIES[c].skinOffAllowed);
    expect(allowed.every((c) => c.startsWith("whitefish_") || c === "other_shark")).toBe(true);
    expect(SPECIES.whitefish_rockfish.skinOffMultiplier).toBe(0.867);
    expect(SPECIES.whitefish_lingcod.skinOffMultiplier).toBe(0.923);
    expect(SPECIES.whitefish_halibut.skinOffMultiplier).toBe(0.85);
    expect(SPECIES.other_shark.skinOffMultiplier).toBe(0.85);
  });

  it("species carry seed shorthand", () => {
    expect(SPECIES.salmon_reds.shorthand).toBe("SOCK");
    expect(SPECIES.whitefish_halibut.shorthand).toBe("HAL");
  });

  it("methods: fresh is virtual, exchange flags, head_off inactive, all lodge-cappable", () => {
    expect(METHODS.fresh.kind).toBe("virtual");
    expect(METHODS.fresh.shorthand).toBeNull();
    expect(METHOD_CODES.filter((m) => METHODS[m].kind === "virtual")).toEqual(["fresh"]);
    expect(METHOD_CODES.filter((m) => METHODS[m].isExchange)).toEqual([
      "smoked_exchange_traditional",
      "smoked_exchange_cajun",
    ]);
    expect(METHOD_CODES.filter((m) => !METHODS[m].isActive)).toEqual(["head_off"]);
    expect(METHOD_CODES.every((m) => METHODS[m].lodgeCappable)).toBe(true);
    expect(METHODS.smoked_exchange_cajun.shorthand).toBe("SX-C");
  });

  it("conditions match the domain-model seed list", () => {
    expect(CONDITION_CODES).toHaveLength(12);
    expect(CONDITIONS.vsr.name).toBe("Vacuum sealed refrigerated");
    expect(isConditionCode("frozen")).toBe(false);
  });

  it("the 250-row yield table is seeded", () => {
    expect(SEED.yield_table).toHaveLength(250);
  });
});

describe("round", () => {
  it("absorbs float noise and rounds half away from zero", () => {
    expect(round(0.6 * 0.85, 4)).toBe(0.51);
    expect(round(1.005, 2)).toBe(1.01);
    expect(round(-1.005, 2)).toBe(-1.01);
    expect(round(0, 2)).toBe(0);
  });
});
