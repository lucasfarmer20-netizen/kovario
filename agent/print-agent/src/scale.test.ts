import { describe, it, expect } from "vitest";
import { parse8217, Toledo8217Stream, StableScale } from "./scale";
describe("WP12 Toledo 8217 protocol fixtures (hardware captures pending)", () => {
  it("parses a stable lb W reply", () =>
    expect(parse8217("\x02 12.50\r")).toEqual({ weightLb: 12.5, stable: true }));
  it("rejects motion, overload, units other than lb and malformed frames", () => {
    for (const frame of [
      "\x02?\x01\r",
      "\x02?\x02\r",
      "\x02 12.5kg\r",
      "12.50\r",
      "\x02-1.00\r",
      "\x02\r",
    ])
      expect(parse8217(frame)).toBeNull();
  });
  it("handles fragmented and concatenated serial frames", () => {
    const p = new Toledo8217Stream();
    expect(p.push(Buffer.from("noise\x02 12."))).toEqual([]);
    expect(p.push(Buffer.from("50\r\x02 13.00\r"))).toEqual([
      { weightLb: 12.5, stable: true },
      { weightLb: 13, stable: true },
    ]);
  });
  it("debounces stable readings, resets on motion, emits changes only", () => {
    const d = new StableScale(),
      s = { weightLb: 10, stable: true };
    expect(d.update(s, 0)).toBeNull();
    expect(d.update(null, 100)).toBeNull();
    expect(d.update(s, 300)).toBeNull();
    expect(d.update(s, 600)).toEqual(s);
    expect(d.update(s, 900)).toBeNull();
    expect(d.update({ ...s, weightLb: 11 }, 1000)).toBeNull();
    expect(d.update({ ...s, weightLb: 11 }, 1300)?.weightLb).toBe(11);
  });
});
