// Freezer location master (docs/04-BUSINESS-RULES.md §7, docs/02-DOMAIN-MODEL.md §7).
// Locations are generated only from the racking actually built (DECISION-15); a scanned
// code is never evidence a shelf exists. Rack positions are grid-shaped
// `<zone>-<row>-<bay 2-digit>-<level>-<F|R>` (`IF-A-01-1-F`); pallet / quarantine
// locations are `<zone>-PALLET-<nn>` and can never be mistaken for a shelf.
// Capacity is display-only: nothing here gates on it (DECISION-14).

export type LocationDepth = "F" | "R";
export const LOCATION_DEPTHS: readonly LocationDepth[] = ["F", "R"];

export const MAX_BAYS = 99;
export const MAX_LEVELS = 9;
/** Upper bound on one generator run (one rack zone). */
export const MAX_GENERATED_LOCATIONS = 2000;
export const PALLET_SEGMENT = "PALLET";

const ZONE = /^[A-Z0-9]{1,8}$/;
const ROW = /^[A-Z0-9]{1,4}$/;
const GRID = /^[A-Z0-9]+-[A-Z0-9]+-\d{2}-\d-[FR]$/;

export interface RackRowSpec {
  row: string;
  bays: number;
  levels: number;
}

export interface RackSpec {
  zone: string;
  rows: readonly RackRowSpec[];
  depths: readonly LocationDepth[];
}

export interface GeneratedRackLocation {
  kind: "rack";
  zone: string;
  row: string;
  bay: number;
  level: number;
  depth: LocationDepth;
  code: string;
}

export interface PalletLocation {
  kind: "pallet";
  zone: string;
  code: string;
}

/** `if` → `IF`. `null` unless 1–8 letters/digits. */
export function normalizeZone(raw: string): string | null {
  const zone = raw.trim().toUpperCase();
  return ZONE.test(zone) ? zone : null;
}

/**
 * `a` → `A`; numeric rows pad to two digits (`1` → `01`) so they walk in numeric order.
 * `null` for anything else, and for `PALLET`: a shelf row can never look like a pallet.
 */
export function normalizeRow(raw: string): string | null {
  const row = raw.trim().toUpperCase();
  if (!ROW.test(row) || row === PALLET_SEGMENT) return null;
  return /^\d+$/.test(row) ? row.replace(/^0+(?=\d)/, "").padStart(2, "0") : row;
}

export function rackCode(
  zone: string,
  row: string,
  bay: number,
  level: number,
  depth: LocationDepth,
) {
  return `${zone}-${row}-${String(bay).padStart(2, "0")}-${level}-${depth}`;
}

/** True for a rack-shelf code. Pallet / quarantine codes are never grid-shaped. */
export function isGridShaped(code: string): boolean {
  return GRID.test(code);
}

function count(name: string, value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new RangeError(`${name} must be a whole number from 1 to ${max}`);
  return value;
}

/**
 * Every shelf position of the racking as built, in walk order (row → bay → level → F
 * before R). Deterministic: the same spec always yields the same codes, so re-running
 * the generator upserts nothing new. Throws `RangeError` on an invalid spec.
 */
export function generateRackLocations(spec: RackSpec): GeneratedRackLocation[] {
  const zone = normalizeZone(spec.zone);
  if (zone === null) throw new RangeError("Zone must be 1–8 letters or digits");
  const depths = LOCATION_DEPTHS.filter((d) => spec.depths.includes(d));
  if (depths.length === 0) throw new RangeError("Choose at least one depth (F or R)");
  if (spec.rows.length === 0) throw new RangeError("Add at least one row");
  const seen = new Set<string>();
  const rows = spec.rows.map((r) => {
    const row = normalizeRow(r.row);
    if (row === null)
      throw new RangeError(`Row ${JSON.stringify(r.row)} must be 1–4 letters/digits, not PALLET`);
    if (seen.has(row)) throw new RangeError(`Row ${row} is listed twice`);
    seen.add(row);
    return {
      row,
      bays: count("Bays", r.bays, MAX_BAYS),
      levels: count("Levels", r.levels, MAX_LEVELS),
    };
  });
  const total = rows.reduce((n, r) => n + r.bays * r.levels * depths.length, 0);
  if (total > MAX_GENERATED_LOCATIONS)
    throw new RangeError(`${total} positions exceeds ${MAX_GENERATED_LOCATIONS} per run`);
  const out: GeneratedRackLocation[] = [];
  for (const { row, bays, levels } of rows)
    for (let bay = 1; bay <= bays; bay++)
      for (let level = 1; level <= levels; level++)
        for (const depth of depths)
          out.push({
            kind: "rack",
            zone,
            row,
            bay,
            level,
            depth,
            code: rackCode(zone, row, bay, level, depth),
          });
  return out;
}

/** `IF-PALLET-01`. Pallet and quarantine locations share this non-grid shape. */
export function palletCode(zone: string, n: number): string {
  const z = normalizeZone(zone);
  if (z === null) throw new RangeError("Zone must be 1–8 letters or digits");
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError("Pallet number must be positive");
  return `${z}-${PALLET_SEGMENT}-${String(n).padStart(2, "0")}`;
}

/** The next unused pallet location in `zone`, given every existing code (any zone). */
export function nextPalletLocation(zone: string, existingCodes: Iterable<string>): PalletLocation {
  const z = normalizeZone(zone);
  if (z === null) throw new RangeError("Zone must be 1–8 letters or digits");
  const prefix = `${z}-${PALLET_SEGMENT}-`;
  let max = 0;
  for (const code of existingCodes)
    if (code.startsWith(prefix) && /^\d+$/.test(code.slice(prefix.length)))
      max = Math.max(max, Number(code.slice(prefix.length)));
  return { kind: "pallet", zone: z, code: palletCode(z, max + 1) };
}

/** SQL projection of the code shapes above. Kept beside the TS generator. */
export function renderLocationShapeSql(): string {
  return `-- GENERATED by packages/rules/src/locations.ts renderLocationShapeSql().
alter table public.location drop constraint if exists location_code_shape;
alter table public.location add constraint location_code_shape check (
 zone ~ '^[A-Z0-9]{1,8}$' and case kind
  when 'rack' then "row" ~ '^[A-Z0-9]{1,4}$' and "row" <> '${PALLET_SEGMENT}'
   and bay between 1 and ${MAX_BAYS} and level between 1 and ${MAX_LEVELS}
   and code = zone || '-' || "row" || '-' || lpad(bay::text, 2, '0') || '-' || level::text || '-' || depth::text
  when 'pallet' then "row" is null and bay is null and level is null
   and code ~ ('^' || zone || '-${PALLET_SEGMENT}-[0-9]{2,}$')
 end
);
`;
}
