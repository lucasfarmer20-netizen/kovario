import { describe, expect, it } from "vitest";
import { CONDITION_CODES } from "./conditions.ts";
import { METHOD_CODES } from "./methods.ts";
import { RATE_CARD_EXTRA_KEYS, referenceSeed } from "./reference-seed.ts";
import { SEED } from "./seed.ts";
import { SPECIES_CODES } from "./species.ts";

describe("referenceSeed (WP-22 onboarding payload)", () => {
  const seed = referenceSeed();

  it("carries every species, condition and method code exactly once", () => {
    expect(seed.species.map((s) => s.code)).toEqual([...SPECIES_CODES]);
    expect(seed.conditions.map((c) => c.code)).toEqual([...CONDITION_CODES]);
    expect(seed.methods.map((m) => m.code)).toEqual([...METHOD_CODES]);
  });

  it("maps seed groups and skin-off from the processing-rules seed", () => {
    const reds = seed.species.find((s) => s.code === "salmon_reds");
    const rock = seed.species.find((s) => s.code === "whitefish_rockfish");
    expect(reds).toMatchObject({ group: "salmon", shorthand: "SOCK", skin_off_allowed: false });
    expect(rock).toMatchObject({ skin_off_allowed: true, skin_off_multiplier: 0.867 });
  });

  it("seeds fresh as virtual, smoked exchange as exchange and head_off inactive", () => {
    const by = Object.fromEntries(seed.methods.map((m) => [m.code, m]));
    expect(by.fresh).toMatchObject({ kind: "virtual", shorthand: null });
    expect(by.smoked_exchange_cajun?.is_exchange).toBe(true);
    expect(by.head_off?.is_active).toBe(false);
    expect(seed.methods.filter((m) => !m.is_active).map((m) => m.code)).toEqual(["head_off"]);
  });

  it("flattens both matrices without loss", () => {
    const condPairs = Object.values(SEED.condition_matrix).flat().length;
    const procTriples = Object.values(SEED.processing_matrix).flat().length;
    expect(seed.condition_matrix).toHaveLength(condPairs);
    expect(seed.processing_matrix).toHaveLength(procTriples);
    expect(seed.processing_matrix).toContainEqual({
      matrix_key: "salmon",
      condition_code: "whole",
      method_code: "fresh",
    });
    expect(seed.processing_matrix.every((r) => r.matrix_key && r.condition_code)).toBe(true);
  });

  it("has the 250 seeded yield factors", () => {
    expect(seed.yield_factors).toHaveLength(250);
    expect(seed.yield_factors.every((y) => y.factor > 0 && y.factor <= 1)).toBe(true);
  });

  it("rate-card extra keys are not method codes", () => {
    expect(RATE_CARD_EXTRA_KEYS.some((k) => (METHOD_CODES as readonly string[]).includes(k))).toBe(
      false,
    );
  });
});
