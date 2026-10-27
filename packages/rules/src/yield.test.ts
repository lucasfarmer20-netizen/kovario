import { describe, expect, it } from "vitest";
import { estimatedYieldLb, seedYieldFactor, yieldFactor, yieldVariancePct } from "./yield.ts";

describe("seedYieldFactor", () => {
  it("exact row", () => {
    expect(seedYieldFactor("salmon_kings", "whole", "portions")).toBe(0.52);
    expect(seedYieldFactor("whitefish_lingcod", "filleted_ribs", "portions")).toBe(0.78);
  });

  it("an exact chum row is used (chum → reds and exchange → smoking: yield.exchange.test.ts)", () => {
    expect(seedYieldFactor("salmon_chum", "gutted", "fillets")).toBe(0.57);
  });

  it("no row and no fallback → null", () => {
    expect(seedYieldFactor("whitefish_flounder", "vs", "as_is")).toBeNull();
  });

  it("fresh split sides are allowed wherever the matrix allows fresh", () => {
    expect(seedYieldFactor("salmon_kings", "whole", "fillets")).toBe(0.56);
    expect(seedYieldFactor("salmon_kings", "whole", "portions")).toBe(0.52);
  });

  it("combinations the processing matrix forbids throw RangeError naming the combination", () => {
    // head_off is a manager add-on outside the matrix.
    expect(() => seedYieldFactor("salmon_kings", "whole", "head_off")).toThrow(
      new RangeError("salmon_kings/whole/head_off is not allowed by the processing matrix"),
    );
    // Concrete method the matrix does not list.
    expect(() => seedYieldFactor("whitefish_lingcod", "whole", "smoking")).toThrow(RangeError);
    // Split sides where fresh itself is forbidden (non-salmon; salmon vsr is Freeze only).
    expect(() => seedYieldFactor("other_octopus", "filleted", "fillets")).toThrow(RangeError);
    expect(() => seedYieldFactor("salmon_kings", "vsr", "portions")).toThrow(RangeError);
    // The matrix has no smoked-exchange rows, even where smoking is allowed.
    expect(() => seedYieldFactor("salmon_chum", "whole", "smoked_exchange_cajun")).toThrow(
      new RangeError(
        "salmon_chum/whole/smoked_exchange_cajun is not allowed by the processing matrix",
      ),
    );
    expect(() => seedYieldFactor("whitefish_lingcod", "whole", "smoked_exchange_cajun")).toThrow(
      RangeError,
    );
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

  it("fresh is checked against the matrix as fresh: forbidden outside salmon (#41)", () => {
    const octopus = { species: "other_octopus", condition: "filleted", method: "fresh" } as const;
    for (const filletsPct of [0, 10, 100]) {
      expect(() => yieldFactor({ ...octopus, filletsPct })).toThrow(
        new RangeError("other_octopus/filleted/fresh is not allowed by the processing matrix"),
      );
    }
    expect(() =>
      yieldFactor({
        species: "other_shrimp",
        condition: "whole",
        method: "fresh",
        filletsPct: 100,
      }),
    ).toThrow(RangeError);
    // Salmon vsr is Freeze only.
    expect(() =>
      yieldFactor({ species: "salmon_reds", condition: "vsr", method: "fresh", filletsPct: 50 }),
    ).toThrow(RangeError);
  });

  it("forbidden concrete methods throw RangeError naming the combination", () => {
    expect(() =>
      yieldFactor({ species: "whitefish_cod", condition: "whole", method: "smoking" }),
    ).toThrow(
      new RangeError("whitefish_cod/whole/smoking is not allowed by the processing matrix"),
    );
    // A salmon line carries fresh; the split sides are not line methods.
    expect(() =>
      yieldFactor({ species: "salmon_kings", condition: "whole", method: "portions" }),
    ).toThrow(RangeError);
    expect(() =>
      yieldFactor({ species: "salmon_kings", condition: "whole", method: "head_off" }),
    ).toThrow(RangeError);
  });

  it("smoked-exchange lines follow the matrix, which has no exchange rows", () => {
    expect(() =>
      yieldFactor({ species: "salmon_chum", condition: "whole", method: "smoked_exchange_cajun" }),
    ).toThrow(RangeError);
    expect(() =>
      yieldFactor({ species: "salmon_reds", condition: "vsf", method: "smoked_exchange_cajun" }),
    ).toThrow(RangeError);
  });

  it("the matrix is checked before skin-off and filletsPct", () => {
    expect(() =>
      yieldFactor({ species: "other_octopus", condition: "filleted", method: "fresh" }),
    ).toThrow(/processing matrix/);
    expect(() =>
      yieldFactor({
        species: "whitefish_cod",
        condition: "whole",
        method: "smoking",
        skinOff: true,
      }),
    ).toThrow(/processing matrix/);
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
