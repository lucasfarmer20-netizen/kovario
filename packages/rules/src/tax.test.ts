import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { REGISTER_SQL_PATH, renderRegisterSql } from "./register-sql";
import { NO_TAX, computeTax, taxSetting } from "./tax";

const sixPct = { mode: "exclusive", rate: 0.06, cap_amount: 30 } as const;

describe("WP16 register tax (§12)", () => {
  it("exclusive: 6% added on top", () => {
    expect(computeTax({ ...sixPct, cap_amount: null }, 100)).toEqual({
      subtotal: 100,
      tax: 6,
      total: 106,
    });
  });

  it("cap: 6% on the first $500 → at most $30 per transaction", () => {
    expect(computeTax(sixPct, 500)).toEqual({ subtotal: 500, tax: 30, total: 530 });
    expect(computeTax(sixPct, 1234.56)).toEqual({ subtotal: 1234.56, tax: 30, total: 1264.56 });
    expect(computeTax(sixPct, 499.99).tax).toBe(30);
    expect(computeTax(sixPct, 400).tax).toBe(24);
  });

  it("rounds half-up to the cent without float drift", () => {
    // 0.25 × 0.06 = 0.015 → 0.02; 10.75 × 0.06 = 0.645 → 0.65
    expect(computeTax({ ...sixPct, cap_amount: null }, 0.25).tax).toBe(0.02);
    expect(computeTax({ ...sixPct, cap_amount: null }, 10.75).tax).toBe(0.65);
    expect(computeTax({ mode: "exclusive", rate: 0.0575, cap_amount: null }, 19.99).tax).toBe(1.15);
  });

  it("inclusive: the tax is inside the subtotal; total = subtotal", () => {
    expect(computeTax({ mode: "inclusive", rate: 0.06, cap_amount: null }, 106)).toEqual({
      subtotal: 106,
      tax: 6,
      total: 106,
    });
    expect(computeTax({ mode: "inclusive", rate: 0.06, cap_amount: 2 }, 106).tax).toBe(2);
  });

  it("none, a zero rate, or a subtotal ≤ 0 carry no tax", () => {
    expect(computeTax(NO_TAX, 100)).toEqual({ subtotal: 100, tax: 0, total: 100 });
    expect(computeTax({ ...sixPct, rate: 0 }, 100).tax).toBe(0);
    expect(computeTax(sixPct, 0).tax).toBe(0);
    expect(computeTax(sixPct, -20)).toEqual({ subtotal: -20, tax: 0, total: -20 });
  });

  it("rejects malformed amounts, rates and caps", () => {
    expect(() => computeTax(sixPct, 1.005)).toThrow(/cents/);
    expect(() => computeTax(sixPct, Number.NaN)).toThrow(/cents/);
    expect(() => computeTax({ ...sixPct, rate: 1.5 }, 1)).toThrow(/rate/);
    expect(() => computeTax({ ...sixPct, rate: -0.01 }, 1)).toThrow(/rate/);
    expect(() => computeTax({ ...sixPct, rate: 0.0000001 }, 1)).toThrow(/rate/);
    expect(() => computeTax({ ...sixPct, cap_amount: -1 }, 1)).toThrow(/cap/);
    expect(() => computeTax({ ...sixPct, cap_amount: 0.001 }, 1)).toThrow(/cap/);
  });

  it("property: tax ≥ 0, never above the cap, and total = subtotal + tax when exclusive", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -100_000, max: 10_000_000 }),
        fc.integer({ min: 0, max: 200_000 }),
        fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: null }),
        fc.constantFrom("exclusive", "inclusive", "none"),
        (cents, micro, capCents, mode) => {
          const cap = capCents === null ? null : capCents / 100;
          const r = computeTax({ mode, rate: micro / 1_000_000, cap_amount: cap }, cents / 100);
          expect(r.tax).toBeGreaterThanOrEqual(0);
          if (cap !== null) expect(r.tax).toBeLessThanOrEqual(cap);
          expect(Math.round(r.total * 100)).toBe(
            cents + (mode === "exclusive" ? Math.round(r.tax * 100) : 0),
          );
        },
      ),
    );
  });
});

describe("taxSetting (org settings.tax)", () => {
  it("normalises the stored setting; missing = no tax, no mode = exclusive", () => {
    expect(taxSetting(undefined)).toEqual(NO_TAX);
    expect(taxSetting([1])).toEqual(NO_TAX);
    expect(taxSetting({ mode: "exclusive", rate: 0.06, cap_amount: 30 })).toEqual(sixPct);
    expect(taxSetting({ rate: 0.05 })).toEqual({ mode: "exclusive", rate: 0.05, cap_amount: null });
    expect(taxSetting({ mode: "bogus", rate: "x" })).toEqual({
      mode: "exclusive",
      rate: 0,
      cap_amount: null,
    });
    expect(taxSetting({ mode: "none" })).toEqual({ mode: "none", rate: 0, cap_amount: null });
  });
});

describe("generated register SQL", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

  it(`${REGISTER_SQL_PATH} is up to date (run \`pnpm --filter rules gen:sql\`)`, () => {
    const committed = readFileSync(resolve(repoRoot, REGISTER_SQL_PATH), "utf8");
    expect(committed.replaceAll("\r\n", "\n")).toBe(renderRegisterSql());
  });

  it("lists every tax mode", () => {
    expect(renderRegisterSql()).toContain("in ('exclusive', 'inclusive', 'none')");
  });
});
