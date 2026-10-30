// Suspect picker, move bin and pull back from blast (v1.1, #88; docs/04-BUSINESS-RULES.md §6b).
// Once a variance hold flags an intake (#87), the manager finds the order its fish actually went
// into among the hold group (variance.ts holdGroup) and moves a bin across. suspects-sql.ts
// renders the SQL forms the database applies; the DB never re-implements them.
import { canTransition } from "./states.ts";
import type { IntakeState } from "./variance.ts";

/**
 * Where a group member is, for the picker. A member is **reconciled** once it is at reconcile
 * with at least one occupied vessel, every one weighed (> 0); before that it is **waiting**
 * (at reconcile, or not yet there). Sent members are **in blast** (blast_freezer, can be pulled
 * back) or **stored** (a vessel is on a shelf: past pulling back).
 */
export type SuspectStatus =
  "upstream" | "at_reconcile" | "reconciled" | "in_blast" | "stored" | "cancelled";
export const SUSPECT_STATUSES: readonly SuspectStatus[] = [
  "upstream",
  "at_reconcile",
  "reconciled",
  "in_blast",
  "stored",
  "cancelled",
];
export const SUSPECT_STATUS_LABELS: Record<SuspectStatus, string> = {
  upstream: "not yet at reconcile",
  at_reconcile: "waiting at reconcile",
  reconciled: "reconciled",
  in_blast: "in blast",
  stored: "stored",
  cancelled: "cancelled",
};
/** Not yet reconciled: the picker lists these and suggests nothing until there are none. */
export const SUSPECT_WAITING: readonly SuspectStatus[] = ["upstream", "at_reconcile"];

/** `vessels` occupied vessels, `unweighed` of them with no positive weight. */
export function suspectStatus(
  state: IntakeState,
  vessels: number,
  unweighed: number,
): SuspectStatus {
  switch (state) {
    case "reconcile":
      return vessels > 0 && unweighed === 0 ? "reconciled" : "at_reconcile";
    case "blast_freezer":
      return "in_blast";
    case "stored":
    case "done":
      return "stored";
    case "cancelled":
      return "cancelled";
    default:
      return "upstream";
  }
}

export function suspectWaiting(status: SuspectStatus): boolean {
  return SUSPECT_WAITING.includes(status);
}

/** One member of the group the picker shows (public.variance_suspect_group). */
export type Suspect = {
  intakeId: string;
  number: string;
  /** −1 before, 0 the flagged (or tapped) intake, 1 and 2 after, in rollstock order. */
  position: number;
  status: SuspectStatus;
  /** Size: estimated yield, lb. */
  expectedLb: number;
  actualLb: number;
  species: readonly string[];
};

export type RankedSuspect = Suspect & {
  /** actual − expected, lb; null while the member is waiting (its actual is not yet known). */
  diffLb: number | null;
  /** Its variance has the opposite sign to the flagged intake's. */
  opposite: boolean;
  /** |flagged diff + this diff|, lb, when opposite: how much is left after cancelling. */
  residualLb: number | null;
  sharedSpecies: number;
};

function cents(lb: number): number {
  if (!Number.isFinite(lb)) throw new RangeError("weights must be finite");
  return Math.round(lb * 100);
}

function diffCents(s: Suspect): number | null {
  return suspectWaiting(s.status) ? null : cents(s.actualLb) - cents(s.expectedLb);
}

/**
 * The flagged intake's suspects, best first: (a) a variance of the opposite sign whose lb
 * difference best cancels the flagged intake's (smallest residual), then (b) more species in
 * common, then (c) the smaller order (estimated yield), then rollstock order. Members whose
 * variance is not opposite follow, by (b), (c) and rollstock order; then members still waiting
 * (no variance yet), the same way.
 * Cancelled members and the flagged intake itself are not suspects.
 */
export function rankSuspects(flagged: Suspect, members: readonly Suspect[]): RankedSuspect[] {
  const flaggedDiff = diffCents(flagged) ?? 0;
  const flaggedSpecies = new Set(flagged.species);
  const ranked = members
    .filter((m) => m.intakeId !== flagged.intakeId && m.status !== "cancelled")
    .map((m) => {
      const diff = diffCents(m);
      const opposite = diff !== null && diff * flaggedDiff < 0;
      const residual = opposite ? Math.abs(flaggedDiff + diff) : Infinity;
      const suspect: RankedSuspect = {
        ...m,
        diffLb: diff === null ? null : diff / 100,
        opposite,
        residualLb: opposite ? residual / 100 : null,
        sharedSpecies: new Set(m.species.filter((s) => flaggedSpecies.has(s))).size,
      };
      return { suspect, residual, size: cents(m.expectedLb) };
    });
  ranked.sort(
    ({ suspect: a, ...x }, { suspect: b, ...y }) =>
      Number(b.opposite) - Number(a.opposite) ||
      (a.opposite ? x.residual - y.residual : 0) ||
      Number(b.diffLb !== null) - Number(a.diffLb !== null) ||
      b.sharedSpecies - a.sharedSpecies ||
      x.size - y.size ||
      a.position - b.position ||
      (a.number < b.number ? -1 : a.number > b.number ? 1 : 0),
  );
  return ranked.map((r) => r.suspect);
}

/** Members still waiting, in rollstock order: suggestions wait for every one of them. */
export function suspectsWaiting<T extends Pick<Suspect, "status" | "position">>(
  members: readonly T[],
): T[] {
  return members.filter((m) => suspectWaiting(m.status)).sort((a, b) => a.position - b.position);
}

/** An occupied vessel of a group member: the bin the manager can move. */
export type SuspectBin = {
  vesselId: string;
  intakeId: string;
  weightLb: number;
};

export type SuggestedMove = {
  vesselId: string;
  fromIntakeId: string;
  toIntakeId: string;
  weightLb: number;
  /** Members in blast that must be pulled back to reconcile before the move. */
  pullBack: string[];
  /** Combined |variance| (lb) of the two intakes after the move, against before. */
  beforeLb: number;
  afterLb: number;
};

/** A member whose bins can move once it is at reconcile (in blast: after a pull back). */
function canHoldMove(status: SuspectStatus): boolean {
  return status === "reconciled" || status === "in_blast";
}

/**
 * Suggested bin moves, best suspect first: only once every group member is reconciled (none
 * waiting); otherwise none. For each opposite-variance suspect, the bin of the intake that is
 * over, moved to the one that is under, that leaves the two closest to their expected yield in
 * total, when that is closer than now. A member in blast must be pulled back first; a stored or
 * cancelled one cannot take part.
 */
export function suggestMoves(
  flagged: Suspect,
  members: readonly Suspect[],
  bins: readonly SuspectBin[],
): SuggestedMove[] {
  if (suspectsWaiting([flagged, ...members]).length > 0) return [];
  if (!canHoldMove(flagged.status)) return [];
  const flaggedDiff = diffCents(flagged)!;
  const moves: SuggestedMove[] = [];
  for (const suspect of rankSuspects(flagged, members)) {
    if (!suspect.opposite || !canHoldMove(suspect.status)) continue;
    const suspectDiff = Math.round(suspect.diffLb! * 100);
    const [from, fromDiff, to, toDiff] =
      flaggedDiff > 0
        ? [flagged, flaggedDiff, suspect, suspectDiff]
        : [suspect, suspectDiff, flagged, flaggedDiff];
    const before = Math.abs(fromDiff) + Math.abs(toDiff);
    let best: { bin: SuspectBin; after: number; weight: number } | null = null;
    for (const bin of bins) {
      if (bin.intakeId !== from.intakeId) continue;
      const weight = cents(bin.weightLb);
      if (weight <= 0) continue;
      const after = Math.abs(fromDiff - weight) + Math.abs(toDiff + weight);
      if (
        !best ||
        after < best.after ||
        (after === best.after &&
          (weight < best.weight || (weight === best.weight && bin.vesselId < best.bin.vesselId)))
      )
        best = { bin, after, weight };
    }
    if (!best || best.after >= before) continue;
    moves.push({
      vesselId: best.bin.vesselId,
      fromIntakeId: from.intakeId,
      toIntakeId: to.intakeId,
      weightLb: best.weight / 100,
      pullBack: [from, to].filter((m) => m.status === "in_blast").map((m) => m.intakeId),
      beforeLb: before / 100,
      afterLb: best.after / 100,
    });
  }
  return moves;
}

// Move bin ----------------------------------------------------------------------------------

/** A bin moves only between intakes at reconcile; one in blast is pulled back first. */
export const MOVE_BIN_STATES: readonly IntakeState[] = ["reconcile"];

export function binMovable(state: IntakeState): boolean {
  return MOVE_BIN_STATES.includes(state);
}

/** `%s` is the intake number (SQL: format()). */
export const BIN_IN_BLAST = "%s is in the blast freezer; pull it back to reconcile first";
export const BIN_NOT_AT_RECONCILE = "%s is not at reconcile";
export const BIN_POOLED = "%s is in a counter allocation; its baskets cannot move";

/**
 * Null when bins can move into or out of the intake, else the message: it must be at reconcile,
 * and not pooled by a non-cancelled allocation session (whose release wizard projects exactly
 * its occupied vessels, I15/I17).
 */
export function binMoveProblem(
  number: string,
  state: IntakeState,
  poolingSessions: number,
): string | null {
  const message = !binMovable(state)
    ? state === "blast_freezer"
      ? BIN_IN_BLAST
      : BIN_NOT_AT_RECONCILE
    : poolingSessions > 0
      ? BIN_POOLED
      : null;
  return message && message.replace("%s", number);
}

// Pull back from blast -----------------------------------------------------------------------

/** blast_freezer → reconcile, manager only (states.ts). */
export const PULL_BACK_FROM: IntakeState = "blast_freezer";
export const PULL_BACK_TO: IntakeState = "reconcile";
export const PULL_BACK_REASON_MAX = 500;
export const PULL_BACK_NEEDS_REASON = "Pull back needs a reason";
export const PULL_BACK_REASON_TOO_LONG = `Reason must be at most ${PULL_BACK_REASON_MAX} characters`;
export const PULL_BACK_NOT_IN_BLAST = "Only an order in the blast freezer can be pulled back";
/**
 * Unicode White_Space: a reason made only of these is blank. Listed (not `\s`, which differs
 * between JS and Postgres, and Postgres has no `\p{}`) so the SQL form uses the same set.
 */
export const BLANK_CHARS = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
].map((c) => String.fromCodePoint(c));
const NOT_BLANK = new RegExp(`[^${BLANK_CHARS.join("")}]`, "u");

/** Has a character that is not White_Space. */
export function notBlank(text: string | null): boolean {
  return NOT_BLANK.test(text ?? "");
}

/** Length in code points, as Postgres length() counts (an emoji is 1, not 2 UTF-16 units). */
export function codePoints(text: string | null): number {
  return [...(text ?? "")].length;
}
export const PULL_BACK_RELEASED =
  "Fish from this order has already been released; it cannot be pulled back";
export const PULL_BACK_POOLED = "This order is in a counter allocation; it cannot be pulled back";

/**
 * What the database knows besides the state: how many of the intake's vessels are not
 * `occupied` (emptied by a release, or void), and how many non-cancelled allocation sessions
 * pool it. Release already acts on intakes in blast (close gate I10 takes blast_freezer); once
 * fish is handed out or allocated, pulling the intake back to reconcile would strand I10 and
 * change what the session's wizard projects (I15/I17), so it is refused.
 */
export type PullBackFacts = { vesselsNotOccupied: number; poolingSessions: number };
const NO_FACTS: PullBackFacts = { vesselsNotOccupied: 0, poolingSessions: 0 };

/** Null when the intake can be pulled back with this reason, else the message. */
export function pullBackProblem(
  state: IntakeState,
  reason: string | null,
  facts: PullBackFacts = NO_FACTS,
): string | null {
  if (!notBlank(reason)) return PULL_BACK_NEEDS_REASON;
  if (codePoints(reason) > PULL_BACK_REASON_MAX) return PULL_BACK_REASON_TOO_LONG;
  if (
    state !== PULL_BACK_FROM ||
    !canTransition("intake", state, PULL_BACK_TO, { isManager: true })
  )
    return PULL_BACK_NOT_IN_BLAST;
  if (facts.vesselsNotOccupied > 0) return PULL_BACK_RELEASED;
  if (facts.poolingSessions > 0) return PULL_BACK_POOLED;
  return null;
}
