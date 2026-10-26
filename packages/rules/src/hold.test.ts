import { describe, expect, it } from "vitest";
import { DEFAULT_HOLD_HOURS, holdUntil, hoursInCooler, oldestInCoolerFirst } from "./hold.ts";

const intakeAt = new Date("2026-07-01T10:00:00Z");

describe("holdUntil — hold_until = intake_at + hold_hours", () => {
  it("defaults to 48 hours", () => {
    expect(DEFAULT_HOLD_HOURS).toBe(48);
    expect(holdUntil(intakeAt).toISOString()).toBe("2026-07-03T10:00:00.000Z");
  });

  it("uses the org's hold_hours", () => {
    expect(holdUntil(intakeAt, 24).toISOString()).toBe("2026-07-02T10:00:00.000Z");
    expect(holdUntil(intakeAt, 1.5).toISOString()).toBe("2026-07-01T11:30:00.000Z");
    expect(holdUntil(intakeAt, 0).toISOString()).toBe(intakeAt.toISOString());
  });

  it("rejects negative or non-finite hours and invalid dates", () => {
    expect(() => holdUntil(intakeAt, -1)).toThrow(RangeError);
    expect(() => holdUntil(intakeAt, Number.NaN)).toThrow(RangeError);
    expect(() => holdUntil(intakeAt, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => holdUntil(new Date("nope"))).toThrow(RangeError);
  });
});

describe("hoursInCooler", () => {
  it("whole hours since intake", () => {
    expect(hoursInCooler(intakeAt, new Date("2026-07-01T10:59:59Z"))).toBe(0);
    expect(hoursInCooler(intakeAt, new Date("2026-07-03T11:30:00Z"))).toBe(49);
  });

  it("never negative; rejects invalid dates", () => {
    expect(hoursInCooler(intakeAt, new Date("2026-06-30T10:00:00Z"))).toBe(0);
    expect(() => hoursInCooler(intakeAt, new Date("nope"))).toThrow(RangeError);
  });
});

describe("oldestInCoolerFirst", () => {
  it("sorts oldest intake first", () => {
    const rows = [
      { id: "b", intakeAt: new Date("2026-07-02T00:00:00Z") },
      { id: "a", intakeAt: new Date("2026-07-01T00:00:00Z") },
    ];
    expect([...rows].sort(oldestInCoolerFirst).map((r) => r.id)).toEqual(["a", "b"]);
  });
});
