import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildIntakeDraft, savePayload, type IntakeLine, type IntakePricing } from "./intake.ts";
import { RULES_SQL_PATH, renderRulesSql } from "./rules-sql.ts";

const RATES = {
  fillets: 1.5,
  portions: 1.25,
  smoking: 2.75,
  ribbing_per_lb: 0.5,
  fast_pass_per_lb: 2,
};
const plain: IntakePricing = { rates: RATES, fastPass: false, isLodgeGuest: false, lodgeCap: null };

// The WP-07 acceptance pair: salmon fresh 60/40 + a ribbed halibut line.
const SALMON_FRESH: IntakeLine = {
  species: "salmon_silvers",
  condition: "whole",
  method: "fresh",
  lb: 50,
  filletsPct: 60,
};
const HALIBUT_RIBBED: IntakeLine = {
  species: "whitefish_halibut",
  condition: "filleted_ribs",
  method: "portions",
  lb: 30,
};

const summary = (d: ReturnType<typeof buildIntakeDraft>) =>
  d.charges.map((c) => [c.kind, c.rateKey, c.qty, c.unitPrice, c.amount]);

describe("buildIntakeDraft", () => {
  it("salmon fresh 60/40 + ribbed halibut → fillets, portions, portions, ribbing", () => {
    const d = buildIntakeDraft([SALMON_FRESH, HALIBUT_RIBBED], plain);
    expect(summary(d)).toEqual([
      ["processing", "fillets", 30, 1.5, 45],
      ["processing", "portions", 20, 1.25, 25],
      ["processing", "portions", 30, 1.25, 37.5],
      ["ribbing", "ribbing_per_lb", 30, 0.5, 15],
    ]);
    expect(d.ribbing).toBe(true);
    expect(d.totalLb).toBe(80);
    expect(d.totalAmount).toBe(122.5);
    expect(d.lines.map((l) => [l.yieldFactor, l.estYieldLb])).toEqual([
      [0.56, 28],
      [0.95, 28.5],
    ]);
    expect(d.totalEstYieldLb).toBe(56.5);
  });

  it("Fast Pass floors processing charges, never ribbing (DECISION-19)", () => {
    const d = buildIntakeDraft([SALMON_FRESH, HALIBUT_RIBBED], { ...plain, fastPass: true });
    expect(summary(d).map((c) => [c[1], c[3]])).toEqual([
      ["fillets", 2],
      ["portions", 2],
      ["portions", 2],
      ["ribbing_per_lb", 0.5],
    ]);
  });

  it("Fast Pass overrides the lodge cap", () => {
    const d = buildIntakeDraft([HALIBUT_RIBBED], {
      ...plain,
      fastPass: true,
      isLodgeGuest: true,
      lodgeCap: 1,
    });
    expect(d.charges.map((c) => c.unitPrice)).toEqual([2, 0.5]);
  });

  it("the lodge cap applies to cappable methods only and never to ribbing", () => {
    const lodge = { ...plain, isLodgeGuest: true, lodgeCap: 1.3 };
    expect(
      buildIntakeDraft([SALMON_FRESH, HALIBUT_RIBBED], lodge).charges.map((c) => c.unitPrice),
    ).toEqual([1.3, 1.25, 1.25, 0.5]);
    const notCappable = buildIntakeDraft([SALMON_FRESH], {
      ...lodge,
      lodgeCappable: { fillets: false },
    });
    expect(notCappable.charges.map((c) => c.unitPrice)).toEqual([1.5, 1.25]);
  });

  it("missing rates leave charges unpriced and are listed", () => {
    const d = buildIntakeDraft([SALMON_FRESH], {
      ...plain,
      rates: { portions: 1 },
      fastPass: true,
    });
    expect(d.totalAmount).toBeNull();
    expect(d.missingRates).toEqual(["fast_pass_per_lb", "fillets"]);
  });

  it("amount rounds the stored 2 dp qty like charge.amount", () => {
    const d = buildIntakeDraft(
      [{ species: "salmon_reds", condition: "whole", method: "fresh", lb: 12.3, filletsPct: 33 }],
      { ...plain, rates: { ...RATES, fillets: 1.99 } },
    );
    // qty 4.059 → stored 4.06; 4.06 × 1.99 = 8.0794 → 8.08
    expect(d.charges[0]!.amount).toBe(8.08);
  });

  it("skin-off applies the species multiplier to the yield snapshot", () => {
    const d = buildIntakeDraft(
      [
        {
          species: "whitefish_rockfish",
          condition: "whole",
          method: "portions",
          lb: 10,
          skinOff: true,
        },
      ],
      plain,
    );
    const base = buildIntakeDraft(
      [{ species: "whitefish_rockfish", condition: "whole", method: "portions", lb: 10 }],
      plain,
    );
    expect(d.lines[0]!.yieldFactor).toBeCloseTo(base.lines[0]!.yieldFactor! * 0.867, 4);
  });

  it("rejects combinations the matrices forbid", () => {
    expect(() =>
      buildIntakeDraft([{ ...HALIBUT_RIBBED, method: "fresh", filletsPct: 50 }], plain),
    ).toThrow(RangeError);
  });
});

describe("savePayload", () => {
  const header = {
    customerId: "c-1",
    toteCount: 2,
    dirtyFish: false,
    dirtyNotes: "ignored when clean",
    cutNotes: "  ",
    processingNotes: " thin ",
    fastPass: false,
  };

  it("carries the yield snapshot and charge drafts, never a price", () => {
    const p = savePayload(header, [SALMON_FRESH, { ...HALIBUT_RIBBED, notes: " big one " }]);
    expect(p.lines).toEqual([
      {
        species_code: "salmon_silvers",
        condition_code: "whole",
        method_code: "fresh",
        lb: 50,
        fillets_pct: 60,
        skin_off: false,
        yield_factor: 0.56,
        notes: null,
      },
      {
        species_code: "whitefish_halibut",
        condition_code: "filleted_ribs",
        method_code: "portions",
        lb: 30,
        fillets_pct: null,
        skin_off: false,
        yield_factor: 0.95,
        notes: "big one",
      },
    ]);
    expect(p.charges.map((c) => [c.kind, c.line_index, c.rate_key, c.qty])).toEqual([
      ["processing", 0, "fillets", 30],
      ["processing", 0, "portions", 20],
      ["processing", 1, "portions", 30],
      ["ribbing", 1, "ribbing_per_lb", 30],
    ]);
    expect(JSON.stringify(p)).not.toMatch(/price|amount/);
    expect([p.dirty_notes, p.cut_notes, p.processing_notes]).toEqual([null, null, "thin"]);
    expect([p.intake_id, p.print_receipt]).toEqual([null, false]);
  });

  it("requires at least one line and a positive whole tote count", () => {
    expect(() => savePayload(header, [])).toThrow(/at least one line/);
    expect(() => savePayload({ ...header, toteCount: 0 }, [SALMON_FRESH])).toThrow(/tote count/);
    expect(() => savePayload({ ...header, toteCount: 1.5 }, [SALMON_FRESH])).toThrow(/tote count/);
  });
});

describe("generated rules SQL", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

  it(`${RULES_SQL_PATH} is up to date (run \`pnpm --filter rules gen:sql\`)`, () => {
    const committed = readFileSync(resolve(repoRoot, RULES_SQL_PATH), "utf8");
    expect(committed.replaceAll("\r\n", "\n")).toBe(renderRulesSql());
  });

  it("encodes tote QR text with the qr.ts prefix and intake-number pattern", () => {
    const sql = renderRulesSql();
    expect(sql).toContain("'FL:TOTE:' || p_intake_number");
    expect(sql).toContain("!~ '^INT-\\d{4,}$'");
  });
});
