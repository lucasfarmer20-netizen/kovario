import { describe, expect, it } from "vitest";
import { normalizeTagCode } from "rules";
import { activeTagSheet, TAG_LIST_PAGE_SIZE, tagListPage, tagRangeProblem } from "./asset-tags";
import { PAGE_SIZE } from "./locations";

/** A query that returns at most `cap` rows per request, like PostgREST's max_rows. */
function cappedSource<T>(rows: T[], cap: number) {
  const calls: [number, number][] = [];
  const page = (from: number, to: number) => {
    calls.push([from, to]);
    return Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + cap)), error: null });
  };
  return { page, calls };
}

/** Tags 0001–1400, as one Create range of a new plant makes them. */
const pool = Array.from({ length: 1400 }, (_, i) => ({
  code: normalizeTagCode(String(i + 1), 4)!,
}));

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

describe("a pool beyond the PostgREST row cap (#85)", () => {
  it("prints every active tag of a 1400-tag pool, not the first 1000", async () => {
    const { page, calls } = cappedSource(pool, PAGE_SIZE);
    const sheet = await activeTagSheet(page, "demo", 4);
    expect(sheet.match(/\^XA/g)).toHaveLength(1400);
    expect(sheet).toContain("FL:TAG:demo:1001");
    expect(sheet).toContain("FL:TAG:demo:1400");
    expect(calls).toEqual([
      [0, 999],
      [1000, 1999],
      [1400, 2399],
    ]);
  });

  it("still prints every tag when the server cap is below the page size", async () => {
    const sheet = await activeTagSheet(cappedSource(pool, 300).page, "demo", 4);
    expect(sheet.match(/\^XA/g)).toHaveLength(1400);
  });

  it("an empty pool asks for tags first", async () => {
    await expect(activeTagSheet(cappedSource([], PAGE_SIZE).page, "demo", 4)).rejects.toThrow(
      "Create tags first.",
    );
  });

  it("the tag list pages through the whole pool", () => {
    expect(TAG_LIST_PAGE_SIZE).toBeLessThanOrEqual(PAGE_SIZE);
    expect(tagListPage(undefined, 1400)).toEqual({ page: 1, pages: 3, from: 0, to: 499 });
    expect(tagListPage("3", 1400)).toEqual({ page: 3, pages: 3, from: 1000, to: 1499 });
    expect(tagListPage("9", 1400).page).toBe(3);
    expect(tagListPage("0", 1400).page).toBe(1);
    expect(tagListPage("x", 1400).page).toBe(1);
    expect(tagListPage(undefined, 0)).toEqual({ page: 1, pages: 1, from: 0, to: 499 });
    // Every tag lands on exactly one page.
    const seen = [1, 2, 3].flatMap((n) => {
      const { from, to } = tagListPage(String(n), pool.length);
      return pool.slice(from, to + 1);
    });
    expect(seen).toEqual(pool);
  });
});
