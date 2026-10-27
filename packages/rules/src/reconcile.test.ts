import { it, expect } from "vitest";
import { normalizeTagCode } from "./qr";
import { variancePercent } from "./reconcile";
it("WP12 tag padding variants resolve to one canonical code", () => {
  expect(["42", "042", "0042"].map((v) => normalizeTagCode(v))).toEqual(["042", "042", "042"]);
});
it("WP12 variance is actual minus expected divided by expected", () => {
  expect(variancePercent(90, 100)).toBe(-10);
  expect(variancePercent(110, 100)).toBe(10);
  expect(variancePercent(2, 0)).toBeNull();
});
