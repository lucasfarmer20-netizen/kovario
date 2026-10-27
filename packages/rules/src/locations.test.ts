import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  generateRackLocations,
  isGridShaped,
  nextPalletLocation,
  normalizeRow,
  palletCode,
  renderLocationShapeSql,
  type RackSpec,
} from "./locations";
import { encode, parse } from "./qr";

const spec: RackSpec = {
  zone: "if",
  rows: [
    { row: "a", bays: 2, levels: 2 },
    { row: "B", bays: 1, levels: 3 },
  ],
  depths: ["R", "F"],
};

describe("WP13 location generator", () => {
  it("WP13 generator emits every built position in walk order (row → bay → level → F before R)", () => {
    const codes = generateRackLocations(spec).map((l) => l.code);
    expect(codes.slice(0, 5)).toEqual([
      "IF-A-01-1-F",
      "IF-A-01-1-R",
      "IF-A-01-2-F",
      "IF-A-01-2-R",
      "IF-A-02-1-F",
    ]);
    expect(codes).toHaveLength(2 * 2 * 2 + 1 * 3 * 2);
    expect(codes.at(-1)).toBe("IF-B-01-3-R");
  });

  it("WP13 generator is idempotent: same spec, same codes, no duplicates", () => {
    const first = generateRackLocations(spec);
    expect(generateRackLocations(spec)).toEqual(first);
    expect(new Set(first.map((l) => l.code)).size).toBe(first.length);
  });

  it("WP13 generator honours per-row bays/levels and a single depth", () => {
    const front = generateRackLocations({ ...spec, depths: ["F"] });
    expect(front.every((l) => l.depth === "F")).toBe(true);
    expect(front.filter((l) => l.row === "B").map((l) => l.level)).toEqual([1, 2, 3]);
  });

  it("WP13 generator never emits a pallet-shaped code", () => {
    expect(() =>
      generateRackLocations({ ...spec, rows: [{ row: "pallet", bays: 1, levels: 1 }] }),
    ).toThrow(RangeError);
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Z0-9]{1,4}$/),
        fc.integer({ min: 1, max: 99 }),
        fc.integer({ min: 1, max: 9 }),
        (row, bays, levels) => {
          if (row === "PALLET") return;
          const out = generateRackLocations({
            zone: "OF",
            rows: [{ row, bays: Math.min(bays, 5), levels }],
            depths: ["F", "R"],
          });
          return out.every((l) => isGridShaped(l.code) && !l.code.includes("PALLET"));
        },
      ),
    );
  });

  it("WP13 numeric rows pad so they walk in numeric order", () => {
    expect(["1", "02", "10"].map(normalizeRow)).toEqual(["01", "02", "10"]);
  });

  it("WP13 generator rejects invalid specs", () => {
    expect(() => generateRackLocations({ ...spec, zone: "I-F" })).toThrow(RangeError);
    expect(() => generateRackLocations({ ...spec, depths: [] })).toThrow(RangeError);
    expect(() =>
      generateRackLocations({ ...spec, rows: [{ row: "A", bays: 0, levels: 1 }] }),
    ).toThrow(RangeError);
    expect(() =>
      generateRackLocations({ ...spec, rows: [{ row: "A", bays: 1, levels: 10 }] }),
    ).toThrow(RangeError);
    expect(() =>
      generateRackLocations({ ...spec, rows: [spec.rows[0]!, { row: "A", bays: 1, levels: 1 }] }),
    ).toThrow(/twice/);
    expect(() =>
      generateRackLocations({
        ...spec,
        rows: [
          { row: "A", bays: 99, levels: 9 },
          { row: "B", bays: 99, levels: 9 },
        ],
      }),
    ).toThrow(/exceeds/);
  });
});

describe("WP13 pallet / quarantine codes", () => {
  it("WP13 pallet code never grid-shaped", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Z0-9]{1,8}$/),
        fc.integer({ min: 1, max: 999 }),
        (zone, n) => {
          const code = palletCode(zone, n);
          return !isGridShaped(code) && code === `${zone}-PALLET-${String(n).padStart(2, "0")}`;
        },
      ),
    );
  });

  it("WP13 next pallet skips existing numbers in the same zone only", () => {
    expect(
      nextPalletLocation("if", ["IF-PALLET-01", "IF-PALLET-07", "OF-PALLET-09", "IF-A-01-1-F"]),
    ).toEqual({
      kind: "pallet",
      zone: "IF",
      code: "IF-PALLET-08",
    });
    expect(nextPalletLocation("OF", []).code).toBe("OF-PALLET-01");
  });

  it("WP13 generated and pallet codes round-trip through the LOC QR codec", () => {
    for (const code of [...generateRackLocations(spec).map((l) => l.code), palletCode("IF", 1)]) {
      const qr = encode("LOC", { orgSlug: "demo-plant", code });
      expect(parse(qr)).toEqual({
        ok: true,
        value: { kind: "LOC", orgSlug: "demo-plant", code, legacy: false },
      });
    }
  });
});

it("WP13 SQL location code shapes remain generated from location rules", () => {
  expect(
    readFileSync(
      fileURLToPath(
        new URL(
          "../../../supabase/migrations/20261027060000_location_code_shape.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  ).toBe(renderLocationShapeSql());
});
