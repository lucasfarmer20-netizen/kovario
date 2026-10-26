import { describe, expect, it } from "vitest";
import { estimatedYieldLb, seedYieldFactor, yieldFactor, yieldVariancePct } from "./yield.ts";

describe("seedYieldFactor", () => {
  it("exact row", () => {
    expect(seedYieldFactor("salmon_kings", "whole", "portions")).toBe(0.52);
    expect(seedYieldFactor("whitefish_lingcod", "filleted_ribs", "portions")).toBe(0.78);
  });

  it("chum falls back to reds", () => {
    // Chum has no smoked-exchange rows; reds does.
    expect(seedYieldFactor("salmon_chum", "whole", "smoked_exchange_cajun")).toBe(0.39);
    // An exact chum row wins over reds.
    expect(seedYieldFactor("salmon_chum", "gutted", "fillets")).toBe(0.57);
  });

  it("exchange methods fall back to smoking", () => {
    expect(seedYieldFactor("salmon_kings", "hg", "smoked_exchange_traditional")).toBe(0.52);
    expect(seedYieldFactor("salmon_pinks", "whole", "smoked_exchange_cajun")).toBe(0.39);
  });

  it("no row and no fallback → null", () => {
    expect(seedYieldFactor("whitefish_flounder", "vs", "as_is")).toBeNull();
    expect(seedYieldFactor("salmon_kings", "whole", "head_off")).toBeNull();
  });
});

describe("yieldFactor", () => {
  it("concrete method", () => {
    expect(yieldFactor({ species: "salmon_reds", condition: "hg", method: "smoking" })).toBe(0.52);
  });

  it("fresh blends fillets and portions by filletsPct", () => {
    const base = { species: "salmon_kings", condition: "whole", method: "fresh" } as const;
    expect(yieldFactor({ ...base, filletsPct: 100 })).toBe(0.56);
    expect(yieldFactor({ ...base, filletsPct: 0 })).toBe(0.52);
    expect(yieldFactor({ ...base, filletsPct: 50 })).toBe(0.54);
    expect(yieldFactor({ ...base, filletsPct: 25 })).toBe(0.53);
  });

  it("fresh with a missing side → null; the unused side is not consulted", () => {
    // Octopus has no fillets row; at 0% fillets only portions is needed.
    const base = { species: "other_octopus", condition: "filleted", method: "fresh" } as const;
    expect(yieldFactor({ ...base, filletsPct: 0 })).toBe(1);
    expect(yieldFactor({ ...base, filletsPct: 10 })).toBeNull();
    // At 100% only the (missing) fillets side is consulted.
    expect(
      yieldFactor({
        species: "other_shrimp",
        condition: "whole",
        method: "fresh",
        filletsPct: 100,
      }),
    ).toBeNull();
  });

  it("fresh requires a valid filletsPct", () => {
    const base = { species: "salmon_reds", condition: "whole", method: "fresh" } as const;
    expect(() => yieldFactor(base)).toThrow(RangeError);
    expect(() => yieldFactor({ ...base, filletsPct: null })).toThrow(RangeError);
    expect(() => yieldFactor({ ...base, filletsPct: -1 })).toThrow(RangeError);
    expect(() => yieldFactor({ ...base, filletsPct: 101 })).toThrow(RangeError);
    expect(() => yieldFactor({ ...base, filletsPct: Number.NaN })).toThrow(RangeError);
  });

  it("skin-off multiplies by the species multiplier", () => {
    const rock = { species: "whitefish_rockfish", condition: "whole", method: "portions" } as const;
    expect(yieldFactor({ ...rock, skinOff: true })).toBe(0.5202); // 0.6 × 0.867
    expect(
      yieldFactor({
        species: "whitefish_lingcod",
        condition: "filleted",
        method: "portions",
        skinOff: true,
      }),
    ).toBe(0.923);
    expect(
      yieldFactor({
        species: "whitefish_halibut",
        condition: "whole",
        method: "portions",
        skinOff: true,
      }),
    ).toBe(0.51);
    expect(
      yieldFactor({
        species: "other_shark",
        condition: "whole",
        method: "portions",
        skinOff: true,
      }),
    ).toBe(0.51);
    expect(yieldFactor({ ...rock, skinOff: false })).toBe(0.6);
  });

  it("skin-off is rejected for species that do not allow it", () => {
    expect(() =>
      yieldFactor({ species: "salmon_reds", condition: "whole", method: "smoking", skinOff: true }),
    ).toThrow(/skin-off/);
  });

  it("skin-off on a combination with no factor → null", () => {
    expect(
      yieldFactor({
        species: "whitefish_flounder",
        condition: "vs",
        method: "as_is",
        skinOff: true,
      }),
    ).toBeNull();
  });
});

describe("estimatedYieldLb", () => {
  it("lb × factor", () => {
    expect(estimatedYieldLb(100, 0.56)).toBe(56);
    expect(estimatedYieldLb(12.5, 0.5202)).toBe(6.503);
    expect(estimatedYieldLb(0, 0.5)).toBe(0);
  });

  it("rejects negative or non-finite input", () => {
    expect(() => estimatedYieldLb(-1, 0.5)).toThrow(RangeError);
    expect(() => estimatedYieldLb(1, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("yieldVariancePct", () => {
  it("(actual − expected) / expected × 100", () => {
    expect(yieldVariancePct(55, 50)).toBe(10);
    expect(yieldVariancePct(45, 50)).toBe(-10);
    expect(yieldVariancePct(10, 3)).toBe(233.33);
  });

  it("nothing expected → null", () => {
    expect(yieldVariancePct(5, 0)).toBeNull();
  });
});
