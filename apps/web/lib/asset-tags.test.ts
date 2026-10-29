import { describe, expect, it } from "vitest";
import { tagRangeProblem } from "./asset-tags";

describe("tagRangeProblem (#85)", () => {
  it("a 4-digit org creates its whole pool, 0–9999, in one range", () => {
    expect(tagRangeProblem(1, 1400, 4)).toBeNull();
    expect(tagRangeProblem(0, 9999, 4)).toBeNull();
    expect(tagRangeProblem(0, 10_000, 4)).toBe("Enter a range from 0 to 9999.");
  });

  it("a 3-digit org stays within 999", () => {
    expect(tagRangeProblem(0, 999, 3)).toBeNull();
    expect(tagRangeProblem(1, 1000, 3)).toBe("Enter a range from 0 to 999.");
  });

  it("wider orgs create at most 10,000 tags per range (admin_asset_tags limit)", () => {
    expect(tagRangeProblem(10_000, 19_999, 5)).toBeNull();
    expect(tagRangeProblem(0, 10_000, 5)).toBe("Create at most 10,000 tags at a time.");
  });

  it("rejects reversed, negative and fractional ranges", () => {
    expect(tagRangeProblem(5, 4, 4)).not.toBeNull();
    expect(tagRangeProblem(-1, 4, 4)).not.toBeNull();
    expect(tagRangeProblem(1.5, 4, 4)).not.toBeNull();
    expect(tagRangeProblem(Number.NaN, 4, 4)).not.toBeNull();
  });
});
