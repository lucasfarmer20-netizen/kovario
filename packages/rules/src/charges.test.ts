import { describe, expect, it } from "vitest";
import { expandLines, hasRibbing } from "./charges.ts";

describe("expandLines", () => {
  it("one processing charge per ordinary line", () => {
    expect(
      expandLines([
        { species: "whitefish_halibut", condition: "whole", method: "portions", lb: 40 },
      ]),
    ).toEqual([
      {
        kind: "processing",
        lineIndex: 0,
        method: "portions",
        rateKey: "portions",
        qty: 40,
        unit: "lb",
        description: "Halibut Whole — Portions",
      },
    ]);
  });

  it("fresh → fillets at lb × pct and portions at the remainder", () => {
    const drafts = expandLines([
      { species: "salmon_reds", condition: "whole", method: "fresh", lb: 12.3, filletsPct: 33 },
    ]);
    expect(drafts.map((d) => [d.method, d.qty])).toEqual([
      ["fillets", 4.059],
      ["portions", 8.241],
    ]);
    expect(drafts[0]!.qty + drafts[1]!.qty).toBeCloseTo(12.3, 9);
  });

  it("Fillets % = 0 → all portions; 100 → all fillets", () => {
    const line = { species: "salmon_kings", condition: "hg", method: "fresh", lb: 20 } as const;
    expect(expandLines([{ ...line, filletsPct: 0 }]).map((d) => [d.method, d.qty])).toEqual([
      ["portions", 20],
    ]);
    expect(expandLines([{ ...line, filletsPct: 100 }]).map((d) => [d.method, d.qty])).toEqual([
      ["fillets", 20],
    ]);
  });

  it("ribbing: one charge per filleted_ribs line, never one per intake", () => {
    const drafts = expandLines([
      { species: "salmon_silvers", condition: "filleted_ribs", method: "smoking", lb: 10 },
      { species: "salmon_reds", condition: "whole", method: "smoking", lb: 30 },
      { species: "whitefish_cod", condition: "filleted_ribs", method: "portions", lb: 8 },
    ]);
    const ribbing = drafts.filter((d) => d.kind === "ribbing");
    expect(ribbing).toEqual([
      {
        kind: "ribbing",
        lineIndex: 0,
        method: null,
        rateKey: "ribbing_per_lb",
        qty: 10,
        unit: "lb",
        description: "Ribbing — Silvers",
      },
      expect.objectContaining({ lineIndex: 2, qty: 8 }),
    ]);
    expect(drafts.filter((d) => d.kind === "processing")).toHaveLength(3);
  });

  it("fresh ribbing line → fillets + portions + ribbing on the whole line lb", () => {
    const drafts = expandLines([
      {
        species: "salmon_reds",
        condition: "filleted_ribs",
        method: "fresh",
        lb: 10,
        filletsPct: 50,
      },
    ]);
    expect(drafts.map((d) => [d.kind, d.rateKey, d.qty])).toEqual([
      ["processing", "fillets", 5],
      ["processing", "portions", 5],
      ["ribbing", "ribbing_per_lb", 10],
    ]);
  });

  it("rejects combinations the matrices do not allow", () => {
    expect(() =>
      expandLines([
        { species: "whitefish_cod", condition: "whole", method: "fresh", lb: 1, filletsPct: 50 },
      ]),
    ).toThrow(/not allowed/);
    expect(() =>
      expandLines([{ species: "salmon_reds", condition: "vsr", method: "as_is", lb: 1 }]),
    ).toThrow(/not allowed/);
  });

  it("rejects bad lb and fillets %", () => {
    const line = { species: "salmon_reds", condition: "whole", method: "fresh", lb: 1 } as const;
    expect(() => expandLines([{ ...line, lb: -1, filletsPct: 50 }])).toThrow(/lb/);
    expect(() => expandLines([line])).toThrow(/filletsPct/);
    expect(() => expandLines([{ ...line, filletsPct: 120 }])).toThrow(/filletsPct/);
    expect(() =>
      expandLines([
        { species: "salmon_reds", condition: "whole", method: "smoking", lb: 1, filletsPct: 50 },
      ]),
    ).toThrow(/fresh only/);
  });

  it("no lines → no charges", () => {
    expect(expandLines([])).toEqual([]);
  });
});

describe("hasRibbing", () => {
  it("true iff any line is filleted_ribs", () => {
    expect(hasRibbing([{ condition: "whole" }, { condition: "filleted_ribs" }])).toBe(true);
    expect(hasRibbing([{ condition: "filleted" }])).toBe(false);
  });
});
