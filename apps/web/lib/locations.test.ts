import { expect, it } from "vitest";
import { generateRackLocations } from "rules";
import { locationTagSheet } from "labels/zpl";
import { fetchAllPages, PAGE_SIZE, parseRackRows } from "./locations";

it("WP13 generator form parses per-row bays and levels", () => {
  expect(parseRackRows("A 12 4\n\n b, 3, 2 \r\n")).toEqual([
    { row: "A", bays: 12, levels: 4 },
    { row: "b", bays: 3, levels: 2 },
  ]);
});

it("WP13 generator form rejects malformed lines with the line number", () => {
  expect(() => parseRackRows("A 12 4\nB twelve 4")).toThrow(/Line 2/);
  expect(() => parseRackRows("A 12")).toThrow(/Line 1/);
});

it("WP13 parsed rows feed the rules generator", () => {
  const codes = generateRackLocations({
    zone: "IF",
    rows: parseRackRows("A 1 1"),
    depths: ["F", "R"],
  }).map((l) => l.code);
  expect(codes).toEqual(["IF-A-01-1-F", "IF-A-01-1-R"]);
});

/** A query source that, like PostgREST with max_rows, never returns more than `cap` rows. */
function cappedSource<T>(rows: T[], cap: number) {
  const calls: [number, number][] = [];
  const page = (from: number, to: number) => {
    calls.push([from, to]);
    return Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + cap)), error: null });
  };
  return { page, calls };
}

it("WP13 tag sheet covers a zone exceeding 1000 locations", async () => {
  const codes = generateRackLocations({
    zone: "IF",
    rows: [{ row: "A", bays: 99, levels: 9 }],
    depths: ["F", "R"],
  }).map((l) => l.code);
  expect(codes).toHaveLength(1782);
  const { page, calls } = cappedSource(
    codes.map((code) => ({ code })),
    PAGE_SIZE,
  );
  const loaded = (await fetchAllPages(page)).map((l) => l.code);
  expect(loaded).toEqual(codes);
  expect(calls).toEqual([
    [0, 999],
    [1000, 1999],
    [1782, 2781],
  ]);
  const sheet = locationTagSheet({ orgSlug: "demo", codes: loaded });
  expect(sheet.match(/\^XA/g)).toHaveLength(891);
  expect(sheet).toContain("FL:LOC:demo:IF-A-99-9-R");
});

it("WP13 paging survives a server cap below the page size", async () => {
  const rows = Array.from({ length: 2500 }, (_, i) => i);
  const { page } = cappedSource(rows, 400);
  expect(await fetchAllPages(page)).toEqual(rows);
});

it("WP13 paging surfaces query errors", async () => {
  await expect(
    fetchAllPages(() => Promise.resolve({ data: null, error: { message: "boom" } })),
  ).rejects.toThrow("boom");
});
