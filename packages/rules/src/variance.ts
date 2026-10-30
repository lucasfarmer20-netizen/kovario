// Variance hold at reconcile (v1.1, #87; docs/04-BUSINESS-RULES.md §6a). A large reconcile
// variance usually means fish went into a neighbouring order at rollstock, so Send to Blast is
// refused over the org's limit and the flagged intake's rollstock neighbours are held with it.
// variance-sql.ts renders the SQL forms of these rules; the DB never re-implements them.
import type { StateOf } from "./states.ts";

export type IntakeState = StateOf<"intake">;

/** org.settings.reconcile.variance_hold_pct: whole percent, default 15, 1–100. */
export const VARIANCE_HOLD_PCT_DEFAULT = 15;
export const VARIANCE_HOLD_PCT_MIN = 1;
export const VARIANCE_HOLD_PCT_MAX = 100;
/** "Near limit" starts at 2/3 of the limit. */
export const NEAR_LIMIT_NUMERATOR = 2;
export const NEAR_LIMIT_DENOMINATOR = 3;
/** The hold group: the flagged intake plus 1 before and 2 after it in rollstock order. */
export const HOLD_GROUP_BEFORE = 1;
export const HOLD_GROUP_AFTER = 2;
/**
 * Neighbours are looked for among intakes opened at rollstock within this many days of the
 * flagged intake (a bound on the query, not the order): an intake opened further apart cannot
 * have shared the rollstock line with it, so it is never a suspect.
 */
export const ROLLSTOCK_NEIGHBOUR_WINDOW_DAYS = 7;

/**
 * within / near (≥ 2/3 of the limit) / over (> the limit); unknown when nothing was expected
 * (no variance, so never held).
 */
export type VarianceBand = "within" | "near" | "over" | "unknown";
export const VARIANCE_BANDS: readonly VarianceBand[] = ["within", "near", "over", "unknown"];

function assertLimit(limitPct: number): void {
  if (
    !Number.isInteger(limitPct) ||
    limitPct < VARIANCE_HOLD_PCT_MIN ||
    limitPct > VARIANCE_HOLD_PCT_MAX
  )
    throw new RangeError(
      `variance hold limit must be a whole percent ${VARIANCE_HOLD_PCT_MIN}–${VARIANCE_HOLD_PCT_MAX}`,
    );
}

function cents(lb: number): number {
  if (!Number.isFinite(lb) || lb < 0) throw new RangeError("weights must be finite and >= 0");
  return Math.round(lb * 100);
}

/**
 * Band of an intake's reconcile variance, compared exactly in hundredths of a lb (weights are
 * numeric(10,2)) so the boundary agrees with the SQL form: |actual − expected| × 100 against
 * limit × expected. At exactly the limit the intake is near, not over.
 */
export function varianceBand(actualLb: number, expectedLb: number, limitPct: number): VarianceBand {
  assertLimit(limitPct);
  const expected = cents(expectedLb);
  const actual = cents(actualLb);
  if (expected <= 0) return "unknown";
  const off = Math.abs(actual - expected) * 100;
  if (off > limitPct * expected) return "over";
  if (off * NEAR_LIMIT_DENOMINATOR >= NEAR_LIMIT_NUMERATOR * limitPct * expected) return "near";
  return "within";
}

/** Send to Blast is refused (and the hold flagged) iff abs(variance) > the limit. */
export function exceedsVarianceHold(
  actualLb: number,
  expectedLb: number,
  limitPct: number,
): boolean {
  return varianceBand(actualLb, expectedLb, limitPct) === "over";
}

/** The text formatVariance (and the generated app.format_variance) is built from. */
export const VARIANCE_NONE = "—";
export const VARIANCE_PLUS = "+";
/** U+2212 minus sign, not a hyphen. */
export const VARIANCE_MINUS = "−";
export const VARIANCE_SUFFIX = "%";

/**
 * "+14%", "−3.5%", "0%"; "—" when there is no variance. One decimal at most, halves away from
 * zero. Rounds to hundredths first (variance_pct has 2 decimals) so float noise such as
 * 1.15 × 10 = 11.4999… cannot differ from the SQL form, app.format_variance. The one variance
 * text: reconcile, blast, refusal messages and reports all show this (#94).
 */
export function formatVariance(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return VARIANCE_NONE;
  const tenths = Math.round(Math.round(Math.abs(pct) * 100) / 10);
  const text = `${tenths / 10}${VARIANCE_SUFFIX}`;
  return tenths === 0 ? text : `${pct > 0 ? VARIANCE_PLUS : VARIANCE_MINUS}${text}`;
}

/** One rollstock scan_log row (station = rollstock). */
export type RollstockScan = {
  intakeId: string;
  scanId: string;
  scannedAt: string;
  ok: boolean;
};

/**
 * The order intakes were actually opened at rollstock: each intake's first accepted rollstock
 * scan, by (scanned_at, scan id). Waves play no part, so the sequence crosses wave boundaries.
 * Rejected scans never open an intake.
 */
export function rollstockSequence(scans: readonly RollstockScan[]): string[] {
  const first = new Map<string, { at: number; scanId: string }>();
  const before = (a: { at: number; scanId: string }, b: { at: number; scanId: string }) =>
    a.at < b.at || (a.at === b.at && a.scanId < b.scanId);
  for (const scan of scans) {
    if (!scan.ok) continue;
    const at = Date.parse(scan.scannedAt);
    if (!Number.isFinite(at)) throw new RangeError(`bad scannedAt ${scan.scannedAt}`);
    const seen = first.get(scan.intakeId);
    if (!seen || before({ at, scanId: scan.scanId }, seen))
      first.set(scan.intakeId, { at, scanId: scan.scanId });
  }
  return [...first.entries()].sort(([, a], [, b]) => (before(a, b) ? -1 : 1)).map(([id]) => id);
}

/**
 * The hold group of `flagged` over the rollstock sequence: HOLD_GROUP_BEFORE intakes before it,
 * itself, and HOLD_GROUP_AFTER after it, clipped at either end, in rollstock order. An intake
 * with no rollstock history is a group of one.
 */
export function holdGroup<T>(sequence: readonly T[], flagged: T): T[] {
  const at = sequence.indexOf(flagged);
  if (at < 0) return [flagged];
  return sequence.slice(Math.max(0, at - HOLD_GROUP_BEFORE), at + HOLD_GROUP_AFTER + 1);
}

/** Not yet sent to blast: the states a hold blocks from Send to Blast. */
export const HOLD_BLOCKED_STATES: readonly IntakeState[] = [
  "draft",
  "holding",
  "processing",
  "rollstock",
  "reconcile",
];
/** Not yet at reconcile: a member here cannot be judged, so it keeps its hold open. */
export const AWAITING_RECONCILE_STATES: readonly IntakeState[] = [
  "draft",
  "holding",
  "processing",
  "rollstock",
];
/** Sent to blast: the actual is the weight at Send to Blast, not the falling remainder. */
export const SENT_STATES: readonly IntakeState[] = ["blast_freezer", "stored", "done"];

export function holdBlocks(state: IntakeState): boolean {
  return HOLD_BLOCKED_STATES.includes(state);
}

export function actualFrozen(state: IntakeState): boolean {
  return SENT_STATES.includes(state);
}

/**
 * A group member keeps its hold open while it is not yet at reconcile, or is at reconcile over
 * the limit without a sign-off at its current weight. Members past reconcile (sent within the
 * limit or signed off) and cancelled members are not judged: their weight can no longer change.
 */
export function memberKeepsHoldOpen(
  state: IntakeState,
  band: VarianceBand,
  signedOffAtCurrentWeight: boolean,
): boolean {
  return (
    AWAITING_RECONCILE_STATES.includes(state) ||
    (state === "reconcile" && band === "over" && !signedOffAtCurrentWeight)
  );
}

/** Manager sign-off reasons (public.variance_signoff_reason). */
export const VARIANCE_SIGNOFF_REASONS = [
  "estimate_wrong",
  "mixed_species",
  "spoilage",
  "trim_heavy",
  "other",
] as const;
export type VarianceSignoffReason = (typeof VARIANCE_SIGNOFF_REASONS)[number];
export const VARIANCE_SIGNOFF_REASON_LABELS: Record<VarianceSignoffReason, string> = {
  estimate_wrong: "Estimate wrong",
  mixed_species: "Mixed species",
  spoilage: "Spoilage",
  trim_heavy: "Trim-heavy",
  other: "Other",
};
export const SIGNOFF_NOTE_MAX = 500;
export const SIGNOFF_UNKNOWN_REASON = "Choose a sign-off reason";
export const SIGNOFF_OTHER_NEEDS_NOTE = "Other needs a note";
export const SIGNOFF_NOTE_TOO_LONG = `Note must be at most ${SIGNOFF_NOTE_MAX} characters`;

/** Null when the sign-off is valid, else the message. "Other" needs a note. */
export function varianceSignoffProblem(reason: string, note: string | null): string | null {
  if (!(VARIANCE_SIGNOFF_REASONS as readonly string[]).includes(reason))
    return SIGNOFF_UNKNOWN_REASON;
  if ((note ?? "").length > SIGNOFF_NOTE_MAX) return SIGNOFF_NOTE_TOO_LONG;
  if (reason === "other" && !/\S/.test(note ?? "")) return SIGNOFF_OTHER_NEEDS_NOTE;
  return null;
}

export const VARIANCE_SETTING_PROBLEM =
  "reconcile.variance_hold_pct must be a whole percent between 1 and 100";

/**
 * org.settings.reconcile is optional (orgs from before v1.1 have none and use the default);
 * when present it is exactly {variance_hold_pct: 1–100, whole}.
 */
export function varianceHoldSettingProblem(settings: Record<string, unknown>): string | null {
  if (!("reconcile" in settings)) return null;
  const reconcile = settings.reconcile;
  if (
    typeof reconcile !== "object" ||
    reconcile === null ||
    Array.isArray(reconcile) ||
    Object.keys(reconcile).join() !== "variance_hold_pct"
  )
    return VARIANCE_SETTING_PROBLEM;
  const pct = (reconcile as { variance_hold_pct: unknown }).variance_hold_pct;
  return typeof pct === "number" &&
    Number.isInteger(pct) &&
    pct >= VARIANCE_HOLD_PCT_MIN &&
    pct <= VARIANCE_HOLD_PCT_MAX
    ? null
    : VARIANCE_SETTING_PROBLEM;
}

/** The org's limit: settings.reconcile.variance_hold_pct, or the default. */
export function varianceHoldLimit(settings: Record<string, unknown>): number {
  const reconcile = settings.reconcile as { variance_hold_pct?: unknown } | undefined;
  return typeof reconcile?.variance_hold_pct === "number"
    ? reconcile.variance_hold_pct
    : VARIANCE_HOLD_PCT_DEFAULT;
}
