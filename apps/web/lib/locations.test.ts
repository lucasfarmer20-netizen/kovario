import { expect, it } from "vitest";
import { generateRackLocations } from "rules";
import { parseRackRows } from "./locations";

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
