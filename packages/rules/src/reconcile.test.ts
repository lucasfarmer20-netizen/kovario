import { it, expect } from "vitest";
import { normalizeTagCode } from "./qr";
import { variancePercent, sendToBlastBlockers } from "./reconcile";
it("WP12 tag padding variants resolve to one canonical code", () => {
  expect(["42", "042", "0042"].map((v) => normalizeTagCode(v))).toEqual(["042", "042", "042"]);
});
it("WP12 variance is actual minus expected divided by expected", () => {
  expect(variancePercent(90, 100)).toBe(-10);
  expect(variancePercent(110, 100)).toBe(10);
  expect(variancePercent(2, 0)).toBeNull();
});
it("WP12 send blockers reject empty, unweighed and untagged regular vessels", () => {
  const regular = { weightLb: 10, isExchange: false, assetTagId: "tag" };
  expect(sendToBlastBlockers([])).toEqual(["no_vessels"]);
  expect(sendToBlastBlockers([{ ...regular, weightLb: 0 }])).toEqual(["non_positive_weight"]);
  expect(sendToBlastBlockers([{ ...regular, assetTagId: null }])).toEqual(["missing_tag"]);
  expect(sendToBlastBlockers([regular])).toEqual([]);
});
it("WP12 exchange is tag exempt but still requires positive weight", () => {
  expect(sendToBlastBlockers([{ weightLb: 10, isExchange: true, assetTagId: null }])).toEqual([]);
  expect(sendToBlastBlockers([{ weightLb: 0, isExchange: true, assetTagId: null }])).toEqual([
    "non_positive_weight",
  ]);
});
