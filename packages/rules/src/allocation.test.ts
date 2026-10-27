import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  HEAVY_BOX_LB,
  boxPlanIssues,
  isHeavy,
  priceSettlements,
  splitAmount,
  splitWeights,
} from "./allocation";
import { ALLOCATION_SQL_PATH, renderAllocationSql } from "./allocation-sql";

const cents = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100);

describe("WP14 penny rule (largest remainder, tie → earlier angler)", () => {
  it("even split of $100.00 over 3 → 33.34 / 33.33 / 33.33", () => {
    expect(splitAmount(100, [1, 1, 1])).toEqual([33.34, 33.33, 33.33]);
  });

  it("even split of $0.05 over 3 → the two leftover cents go to the first two anglers", () => {
    expect(splitAmount(0.05, [1, 1, 1])).toEqual([0.02, 0.02, 0.01]);
  });

  it("weight split goes to the largest remainders, not the first angler", () => {
    // exact: 10 × 1/6 = 1.666…, 10 × 2/6 = 3.333…, 10 × 3/6 = 5 → floors 1.66 / 3.33 / 5.00,
    // one cent left over → the largest remainder (angler 1, .006…) gets it.
    expect(splitAmount(10, [10, 20, 30])).toEqual([1.67, 3.33, 5]);
  });

  it("a zero-lb angler pays no processing share on a weight split", () => {
    expect(splitAmount(50, [0, 12.5, 12.5])).toEqual([0, 25, 25]);
  });

  it("an all-zero weight split is refused (enter lb or split evenly)", () => {
    expect(() => splitAmount(10, [0, 0])).toThrow(/take-home lb/);
  });

  it("rejects negative totals, sub-cent totals, bad weights and no anglers", () => {
    expect(() => splitAmount(-1, [1])).toThrow(RangeError);
    expect(() => splitAmount(1.005, [1])).toThrow(RangeError);
    expect(() => splitAmount(1, [-1, 2])).toThrow(RangeError);
    expect(() => splitAmount(1, [1.001])).toThrow(RangeError);
    expect(() => splitAmount(1, [])).toThrow(RangeError);
  });

  it("weight vs even split: both sum exactly to the pooled charges (property)", () => {
    const amount = fc.integer({ min: 0, max: 10_000_000 }).map((c) => c / 100);
    const lb = fc.integer({ min: 0, max: 100_000 }).map((h) => h / 100);
    fc.assert(
      fc.property(
        amount,
        fc.array(lb, { minLength: 1, maxLength: 12 }).filter((ws) => ws.some((w) => w > 0)),
        (total, anglerLb) => {
          for (const method of ["weight", "even"] as const) {
            const shares = splitAmount(total, splitWeights(method, anglerLb));
            expect(shares).toHaveLength(anglerLb.length);
            expect(cents(shares)).toBe(Math.round(total * 100));
            for (const s of shares) {
              expect(s).toBeGreaterThanOrEqual(0);
              expect(Math.round(s * 100)).toBeCloseTo(s * 100, 6); // whole cents
            }
          }
        },
      ),
    );
  });

  it("no share is more than one cent from its exact proportion (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 8 }),
        (totalCents, w) => {
          fc.pre(w.some((x) => x > 0));
          const sum = w.reduce((a, b) => a + b, 0);
          const shares = splitAmount(totalCents / 100, w);
          shares.forEach((s, i) => {
            expect(Math.abs(s * 100 - (totalCents * w[i]!) / sum)).toBeLessThan(1);
          });
        },
      ),
    );
  });

  it("even split ignores lb", () => {
    expect(splitWeights("even", [0, 40, 3])).toEqual([1, 1, 1]);
    expect(splitWeights("weight", [0, 40, 3])).toEqual([0, 40, 3]);
  });
});

describe("WP14 box plan heavy check", () => {
  it(`over ${HEAVY_BOX_LB} lb needs the heavy acknowledgement; ${HEAVY_BOX_LB} lb itself does not`, () => {
    expect(isHeavy(HEAVY_BOX_LB)).toBe(false);
    expect(boxPlanIssues({ weightLb: 70, heavyAllowed: false })).toEqual([]);
    expect(boxPlanIssues({ weightLb: 70.01, heavyAllowed: false })).toEqual(["heavy_unconfirmed"]);
    expect(boxPlanIssues({ weightLb: 82, heavyAllowed: true })).toEqual([]);
  });

  it("rejects a negative or non-numeric weight", () => {
    expect(boxPlanIssues({ weightLb: -1, heavyAllowed: true })).toEqual(["invalid_weight"]);
    expect(boxPlanIssues({ weightLb: Number.NaN, heavyAllowed: true })).toEqual(["invalid_weight"]);
  });
});

describe("WP14 settlement pricing", () => {
  const anglers = [
    { speciesLb: [20, 10], boxFees: [12.5, 12.5], freight: 0 },
    { speciesLb: [10], boxFees: [12.5], freight: 0 },
    { speciesLb: [0], boxFees: [], freight: 40 },
  ];

  it("weight: processing share ∝ take-home lb; totals = share + box fees + freight", () => {
    const priced = priceSettlements({ pooledProcessing: 100, method: "weight", anglers });
    expect(priced).toEqual([
      {
        weightTotalLb: 30,
        processingShare: 75,
        boxFeeTotal: 25,
        freightTotal: 0,
        amountTotal: 100,
      },
      {
        weightTotalLb: 10,
        processingShare: 25,
        boxFeeTotal: 12.5,
        freightTotal: 0,
        amountTotal: 37.5,
      },
      { weightTotalLb: 0, processingShare: 0, boxFeeTotal: 0, freightTotal: 40, amountTotal: 40 },
    ]);
  });

  it("even: every angler carries the same share (pennies to the first)", () => {
    const priced = priceSettlements({ pooledProcessing: 100, method: "even", anglers });
    expect(priced.map((p) => p.processingShare)).toEqual([33.34, 33.33, 33.33]);
    expect(cents(priced.map((p) => p.processingShare))).toBe(10000);
  });

  it("a session with no anglers cannot be priced", () => {
    expect(() => priceSettlements({ pooledProcessing: 1, method: "even", anglers: [] })).toThrow(
      /at least one angler/,
    );
  });
});

describe("generated allocation SQL", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

  it(`${ALLOCATION_SQL_PATH} is up to date (run \`pnpm --filter rules gen:sql\`)`, () => {
    const committed = readFileSync(resolve(repoRoot, ALLOCATION_SQL_PATH), "utf8");
    expect(committed.replaceAll("\r\n", "\n")).toBe(renderAllocationSql());
  });

  it("encodes the boxing QR with the qr.ts prefix and token pattern", () => {
    const sql = renderAllocationSql();
    expect(sql).toContain("'FL:BOX:' || p_token");
    expect(sql).toContain("!~ '^[A-Za-z0-9_-]+$'");
  });
});
