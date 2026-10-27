import {
  FRESH,
  SPECIES,
  allowedConditions,
  allowedMethods,
  hoursInCooler,
  isConditionCode,
  isMethodCode,
  isSpeciesCode,
  type IntakeLine,
} from "rules";

// Intake station form state (docs/06-STATIONS-UX.md Intake). Dropdowns are the rules
// engine's matrices filtered to the org's active reference rows; nothing here re-implements
// a rule — lines go to packages/rules buildIntakeDraft / savePayload as typed.

/** One editable species line; fields stay strings until parsed. */
export type LineRow = {
  key: string;
  species: string;
  condition: string;
  method: string;
  lb: string;
  filletsPct: string;
  skinOff: boolean;
  notes: string;
};

export type RefRow = { code: string; name: string; sort: number; is_active: boolean };

/** The org's reference rows (names + active flags), keyed by code. */
export type OrgReference = {
  species: RefRow[];
  conditions: RefRow[];
  methods: RefRow[];
};

export type Option = { code: string; name: string };

let rowSeq = 0;
export function emptyRow(): LineRow {
  rowSeq += 1;
  return {
    key: `line-${rowSeq}`,
    species: "",
    condition: "",
    method: "",
    lb: "",
    filletsPct: "",
    skinOff: false,
    notes: "",
  };
}

function active(rows: RefRow[]): Map<string, RefRow> {
  return new Map(rows.filter((r) => r.is_active).map((r) => [r.code, r]));
}

export function speciesOptions(ref: OrgReference): Option[] {
  return [...active(ref.species).values()]
    .filter((r) => isSpeciesCode(r.code))
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
    .map(({ code, name }) => ({ code, name }));
}

/** Conditions the condition matrix allows for the species, in matrix order. */
export function conditionOptions(ref: OrgReference, species: string): Option[] {
  const names = active(ref.conditions);
  return allowedConditions(species).flatMap((code) => {
    const row = names.get(code);
    return row ? [{ code, name: row.name }] : [];
  });
}

/** Methods the processing matrix allows for (species, condition), in matrix order. */
export function methodOptions(ref: OrgReference, species: string, condition: string): Option[] {
  const names = active(ref.methods);
  return allowedMethods(species, condition).flatMap((code) => {
    const row = names.get(code);
    return row ? [{ code, name: row.name }] : [];
  });
}

export function skinOffAllowed(species: string): boolean {
  return isSpeciesCode(species) && SPECIES[species].skinOffAllowed;
}

/**
 * Applies an edit and drops selections the matrices no longer allow: a new species clears
 * an unavailable condition, which clears the method; fillets % only for fresh; skin-off
 * only where the species allows it. A single remaining option is picked for the operator.
 */
export function updateRow(ref: OrgReference, row: LineRow, patch: Partial<LineRow>): LineRow {
  const next = { ...row, ...patch };
  const conditions = conditionOptions(ref, next.species);
  if (!conditions.some((o) => o.code === next.condition)) {
    next.condition = conditions.length === 1 ? conditions[0]!.code : "";
  }
  const methods = methodOptions(ref, next.species, next.condition);
  if (!methods.some((o) => o.code === next.method)) {
    next.method = methods.length === 1 ? methods[0]!.code : "";
  }
  if (next.method !== FRESH) next.filletsPct = "";
  if (!skinOffAllowed(next.species)) next.skinOff = false;
  return next;
}

export function isBlankRow(row: LineRow): boolean {
  return !row.species && !row.lb.trim() && !row.notes.trim();
}

function parseNumber(raw: string): number | null {
  const s = raw.trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Form rows → rules-engine lines. Blank rows are skipped; each problem is reported once. */
export function rowsToLines(rows: LineRow[]): { lines: IntakeLine[]; errors: string[] } {
  const lines: IntakeLine[] = [];
  const errors: string[] = [];
  rows.forEach((row, i) => {
    if (isBlankRow(row)) return;
    const where = `Line ${i + 1}`;
    if (!isSpeciesCode(row.species)) return void errors.push(`${where}: pick a species.`);
    if (!isConditionCode(row.condition)) return void errors.push(`${where}: pick a condition.`);
    if (!isMethodCode(row.method)) return void errors.push(`${where}: pick a method.`);
    const lb = parseNumber(row.lb);
    if (lb === null || lb <= 0 || lb > 9999) {
      return void errors.push(`${where}: enter the weight in lb.`);
    }
    let filletsPct: number | null = null;
    if (row.method === FRESH) {
      filletsPct = parseNumber(row.filletsPct);
      if (filletsPct === null || filletsPct < 0 || filletsPct > 100) {
        return void errors.push(`${where}: enter fillets % (0–100).`);
      }
    }
    lines.push({
      species: row.species,
      condition: row.condition,
      method: row.method,
      lb: Math.round(lb * 100) / 100,
      filletsPct,
      skinOff: row.skinOff,
      notes: row.notes,
    });
  });
  if (lines.length === 0 && errors.length === 0) errors.push("Add at least one species line.");
  return { lines, errors };
}

/** A saved line back into an editable row (manager unlock → edit). */
export function lineToRow(line: {
  species_code: string;
  condition_code: string;
  method_code: string;
  lb: number;
  fillets_pct: number | null;
  skin_off: boolean;
  notes: string | null;
}): LineRow {
  return {
    ...emptyRow(),
    species: line.species_code,
    condition: line.condition_code,
    method: line.method_code,
    lb: String(line.lb),
    filletsPct: line.fillets_pct === null ? "" : String(line.fillets_pct),
    skinOff: line.skin_off,
    notes: line.notes ?? "",
  };
}

export function parseToteCount(raw: string): number | null {
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n >= 1 && n <= 99 ? n : null;
}

// Detail view -----------------------------------------------------------------------------

export type IntakeStamps = {
  intake_at: string;
  hold_until: string | null;
  pulled_at: string | null;
  rollstock_at: string | null;
  rollstock_done_at: string | null;
  reconcile_at: string | null;
  blast_at: string | null;
  stored_at: string | null;
  done_at: string | null;
  cancelled_at: string | null;
};

const TIMELINE: [keyof IntakeStamps, string][] = [
  ["intake_at", "Checked in"],
  ["hold_until", "Cooler hold until"],
  ["pulled_at", "Pulled for processing"],
  ["rollstock_at", "At rollstock"],
  ["rollstock_done_at", "Rollstock done"],
  ["reconcile_at", "Reconciled"],
  ["blast_at", "Into blast freezer"],
  ["stored_at", "Stored"],
  ["done_at", "Picked up"],
  ["cancelled_at", "Cancelled"],
];

/** The intake's timestamps in lifecycle order; unset ones are omitted. */
export function intakeTimeline(stamps: IntakeStamps): { label: string; at: string }[] {
  return TIMELINE.flatMap(([key, label]) => {
    const at = stamps[key];
    return at ? [{ label, at }] : [];
  });
}

/** "18h in cooler" for intakes still waiting in the cooler; null otherwise. */
export function coolerBadge(state: string, intakeAt: string, now: Date): string | null {
  if (state !== "holding") return null;
  return `${hoursInCooler(new Date(intakeAt), now)}h in cooler`;
}

export const STATE_LABELS: Record<string, string> = {
  draft: "Draft",
  holding: "In cooler",
  processing: "Processing",
  rollstock: "Rollstock",
  reconcile: "Reconcile",
  blast_freezer: "Blast freezer",
  stored: "Stored",
  done: "Done",
  cancelled: "Cancelled",
};

export function money(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `$${n.toFixed(2)}`;
}
