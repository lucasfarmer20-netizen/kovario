import type { RackRowSpec } from "rules";

/**
 * Generator form rows: one rack row per line, `<row> <bays> <levels>` (e.g. `A 12 4`).
 * Commas or whitespace separate fields; blank lines are ignored. Validation of the
 * values themselves belongs to rules `generateRackLocations`.
 */
export function parseRackRows(text: string): RackRowSpec[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line, i) => {
      const parts = line.split(/[\s,]+/);
      const [row, bays, levels] = parts;
      if (parts.length !== 3 || !row || !/^\d+$/.test(bays ?? "") || !/^\d+$/.test(levels ?? ""))
        throw new Error(`Line ${i + 1}: expected "<row> <bays> <levels>", e.g. "A 12 4".`);
      return { row, bays: Number(bays), levels: Number(levels) };
    });
}
