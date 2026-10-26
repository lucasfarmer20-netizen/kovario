import { describe, expect, it } from "vitest";
import { allowedConditions, allowedMethods, isAllowed } from "./matrix.ts";
import { SPECIES_CODES } from "./species.ts";

describe("allowedConditions", () => {
  it("uses the group row for ordinary species", () => {
    expect(allowedConditions("salmon_reds")).toEqual([
      "whole",
      "hg",
      "headed",
      "gutted",
      "filleted",
      "filleted_ribs",
      "as_is",
      "vs",
      "vsf",
      "vsr",
    ]);
    expect(allowedConditions("whitefish_cod")).toContain("portions");
    expect(allowedConditions("byproduct_heads")).toEqual(["whole", "vs", "vsf", "vsr"]);
    expect(allowedConditions("other_dolly")).toEqual(["whole", "filleted", "as_is", "vsr"]);
  });

  it("a species-code row overrides its group (shrimp)", () => {
    expect(allowedConditions("other_shrimp")).toEqual(["whole", "tails_only", "vsr"]);
    expect(allowedConditions("other_dolly")).not.toContain("tails_only");
  });

  it("unknown species → none", () => {
    expect(allowedConditions("salmon_atlantic")).toEqual([]);
  });

  it("every species has a condition row", () => {
    for (const s of SPECIES_CODES) expect(allowedConditions(s).length).toBeGreaterThan(0);
  });
});

describe("allowedMethods", () => {
  it("salmon: most → fresh + smoking (some add as-is)", () => {
    expect(allowedMethods("salmon_kings", "whole")).toEqual(["fresh", "smoking"]);
    expect(allowedMethods("salmon_kings", "hg")).toEqual(["fresh", "smoking", "as_is"]);
    expect(allowedMethods("salmon_kings", "filleted_ribs")).toEqual(["fresh", "smoking"]);
  });

  it("salmon as_is|vs|vsf → as-is only", () => {
    for (const c of ["as_is", "vs", "vsf"])
      expect(allowedMethods("salmon_pinks", c)).toEqual(["as_is"]);
  });

  it("VSR must be frozen: freeze only, for every species", () => {
    for (const s of SPECIES_CODES) expect(allowedMethods(s, "vsr")).toEqual(["freeze"]);
  });

  it("VSF → as-is only wherever selectable", () => {
    for (const s of SPECIES_CODES) {
      if (allowedConditions(s).includes("vsf")) expect(allowedMethods(s, "vsf")).toEqual(["as_is"]);
    }
  });

  it("whitefish: most → portions; already portioned → as-is", () => {
    expect(allowedMethods("whitefish_halibut", "whole")).toEqual(["portions"]);
    expect(allowedMethods("whitefish_halibut", "portions")).toEqual(["as_is"]);
  });

  it("shark and shrimp use their species rows", () => {
    expect(allowedMethods("other_shark", "whole")).toEqual(["portions", "as_is"]);
    expect(allowedMethods("other_shrimp", "whole")).toEqual(["portions"]);
    expect(allowedMethods("other_shrimp", "tails_only")).toEqual(["as_is"]);
  });

  it("byproduct: whole/vs/vsf → as-is", () => {
    for (const c of ["whole", "vs", "vsf"])
      expect(allowedMethods("byproduct_eggs", c)).toEqual(["as_is"]);
  });

  it("a condition not allowed for the species → none", () => {
    expect(allowedMethods("salmon_reds", "tails_only")).toEqual([]);
    expect(allowedMethods("other_shrimp", "filleted")).toEqual([]);
    expect(allowedMethods("salmon_reds", "frozen")).toEqual([]);
    expect(allowedMethods("nope", "whole")).toEqual([]);
  });

  it("every allowed condition has at least one method; head_off is never offered", () => {
    for (const s of SPECIES_CODES) {
      for (const c of allowedConditions(s)) {
        const methods = allowedMethods(s, c);
        expect(methods.length, `${s}|${c}`).toBeGreaterThan(0);
        expect(methods).not.toContain("head_off");
      }
    }
  });

  it("isAllowed", () => {
    expect(isAllowed("salmon_reds", "whole", "fresh")).toBe(true);
    expect(isAllowed("whitefish_cod", "whole", "fresh")).toBe(false);
    expect(isAllowed("salmon_reds", "whole", "head_off")).toBe(false);
  });
});
