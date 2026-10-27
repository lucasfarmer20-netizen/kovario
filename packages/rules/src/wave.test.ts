import { describe, expect, it } from "vitest";
import { suggestWave } from "./wave";

const row = (id: string, lb: number, day: number) => ({
  id,
  total_incoming_lb: lb,
  intake_at: `2026-10-${day}T00:00:00Z`,
});
describe("WP10 FIFO suggestion (advisory)", () => {
  it("fills oldest first into the tolerance band without mutating the queue", () => {
    const queue = [row("b", 90, 22), row("a", 100, 21), row("c", 30, 23)];
    expect(suggestWave(queue, 200, 10).map((x) => x.id)).toEqual(["a", "b"]);
    expect(queue[0]?.id).toBe("b");
  });
  it("does not skip older heavy intakes to cherry-pick newer ones", () => {
    expect(suggestWave([row("a", 500, 21), row("b", 10, 22)], 100, 5).map((x) => x.id)).toEqual([
      "a",
    ]);
  });
  it("chooses the nearest FIFO prefix when the band cannot be reached", () => {
    expect(suggestWave([row("a", 90, 21), row("b", 50, 22)], 100, 0)).toHaveLength(1);
    expect(suggestWave([row("a", 40, 21), row("b", 70, 22)], 100, 0)).toHaveLength(2);
  });
  it("handles empty and undersized queues and stable timestamp ties", () => {
    expect(suggestWave([])).toEqual([]);
    expect(suggestWave([row("b", 10, 21), row("a", 10, 21)]).map((x) => x.id)).toEqual(["a", "b"]);
  });
  it("rejects invalid settings", () => {
    for (const [target, tolerance] of [
      [0, 0],
      [NaN, 1],
      [100, -1],
      [100, Infinity],
    ])
      expect(() => suggestWave([], target, tolerance)).toThrow(RangeError);
  });
});
