import { describe, expect, it } from "vitest";
import { pricePerLb, repriceEligible } from "./pricing.ts";

const base = { method: "portions", listPrice: 2.5, isLodgeGuest: false, fastPass: false } as const;

describe("pricePerLb — the one rule", () => {
  it("list price by default", () => {
    expect(pricePerLb(base)).toBe(2.5);
  });

  it("Fast Pass floors at fast_pass_rate", () => {
    expect(pricePerLb({ ...base, fastPass: true, fastPassRate: 3 })).toBe(3);
    expect(pricePerLb({ ...base, listPrice: 4, fastPass: true, fastPassRate: 3 })).toBe(4);
  });

  it("Fast Pass overrides the lodge cap", () => {
    expect(
      pricePerLb({ ...base, fastPass: true, fastPassRate: 3, isLodgeGuest: true, lodgeCap: 2 }),
    ).toBe(3);
  });

  it("Fast Pass without a rate is an error", () => {
    expect(() => pricePerLb({ ...base, fastPass: true })).toThrow(RangeError);
    expect(() => pricePerLb({ ...base, fastPass: true, fastPassRate: null })).toThrow(RangeError);
    expect(() => pricePerLb({ ...base, fastPass: true, fastPassRate: -1 })).toThrow(RangeError);
  });

  it("lodge guests are capped", () => {
    expect(pricePerLb({ ...base, isLodgeGuest: true, lodgeCap: 2 })).toBe(2);
    expect(pricePerLb({ ...base, isLodgeGuest: true, lodgeCap: 3 })).toBe(2.5);
  });

  it("no cap when the lodge has none, or the customer is not a guest", () => {
    expect(pricePerLb({ ...base, isLodgeGuest: true })).toBe(2.5);
    expect(pricePerLb({ ...base, isLodgeGuest: true, lodgeCap: null })).toBe(2.5);
    expect(pricePerLb({ ...base, isLodgeGuest: false, lodgeCap: 1 })).toBe(2.5);
  });

  it("the cap applies only to lodge-cappable methods", () => {
    expect(pricePerLb({ ...base, isLodgeGuest: true, lodgeCap: 1, lodgeCappable: false })).toBe(
      2.5,
    );
    expect(pricePerLb({ ...base, isLodgeGuest: true, lodgeCap: 1, lodgeCappable: true })).toBe(1);
  });

  it("ribbing is never capped (nor floored)", () => {
    const ribbing = { ...base, method: "ribbing", listPrice: 0.5 } as const;
    expect(pricePerLb({ ...ribbing, isLodgeGuest: true, lodgeCap: 0.25 })).toBe(0.5);
    expect(pricePerLb({ ...ribbing, fastPass: true, fastPassRate: 3 })).toBe(0.5);
  });

  it("rejects invalid rates", () => {
    expect(() => pricePerLb({ ...base, listPrice: -1 })).toThrow(RangeError);
    expect(() => pricePerLb({ ...base, listPrice: Number.NaN })).toThrow(RangeError);
    expect(() => pricePerLb({ ...base, isLodgeGuest: true, lodgeCap: -2 })).toThrow(RangeError);
  });
});

describe("repriceEligible — lodge flip is the only retro path", () => {
  const open = { kind: "processing", state: "open" } as const;
  const intake = { fastPass: false };

  it("open, unpaid, non-Fast-Pass processing charge → eligible", () => {
    expect(repriceEligible(open, intake)).toBe(true);
    expect(repriceEligible({ ...open, settledPaymentId: null }, intake)).toBe(true);
  });

  it("Fast Pass is never repriced", () => {
    expect(repriceEligible(open, { fastPass: true })).toBe(false);
  });

  it("ribbing and other kinds are never repriced", () => {
    expect(repriceEligible({ ...open, kind: "ribbing" }, intake)).toBe(false);
    expect(repriceEligible({ ...open, kind: "storage" }, intake)).toBe(false);
  });

  it("settled, voided, comped or paid charges are not repriced", () => {
    for (const state of ["settled", "voided", "comped"] as const) {
      expect(repriceEligible({ ...open, state }, intake)).toBe(false);
    }
    expect(repriceEligible({ ...open, settledPaymentId: "pay_1" }, intake)).toBe(false);
  });
});
