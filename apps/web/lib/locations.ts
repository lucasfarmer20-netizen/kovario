import type { RackRowSpec } from "rules";

/** PostgREST's row cap per request (`supabase/config.toml` `max_rows`). */
export const PAGE_SIZE = 1000;

type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/**
 * Every row of a query, one `.range(from, to)` page at a time. The query must have a
 * stable, unique ordering. Reads until an empty page rather than trusting a short page,
 * so a server cap below `size` cannot silently truncate the result.
 */
export async function fetchAllPages<T>(
  page: (from: number, to: number) => Page<T>,
  size: number = PAGE_SIZE,
): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const { data, error } = await page(rows.length, rows.length + size - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) return rows;
    rows.push(...data);
  }
}

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
