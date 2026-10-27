// Release rules (docs/10-LESSONS-FROM-CSP.md §2, docs/04-BUSINESS-RULES.md §9). Founding
// rule: box-finalisation and tote-freeing are independent facts the crew reports; nothing
// here links a box to a vessel. The database applies the same rules inside release_party /
// release_by_tag / shipment_buy_check through app.release_line_issue,
// app.vessel_release_action and app.shipment_buy_gate, generated from this file
// (release-sql.ts); the boxing screen validates with the same functions before Complete.

export type VesselReleaseAction = "none" | "full_pull" | "split";

export const LBS_LEFT_NOT_A_NUMBER = "Lbs Left must be a number";
export const LBS_LEFT_NEGATIVE = "Lbs Left cannot be negative";
/** Weights are stored as numeric(10,2): a finer remainder would be split, then rounded. */
export const LBS_LEFT_TOO_PRECISE = "Lbs Left takes at most 2 decimal places";
export const LBS_LEFT_ON_UNTICKED =
  "Lbs Left on an unticked line; tick the tote or clear the value";
export const LBS_LEFT_NOT_LESS_THAN_MEASURE =
  "Lbs Left must be less than the basket's current weight; leave it blank or 0 for a full pull";

/**
 * I5 / I16(a): the input fault on one vessel line, or null when the line is valid.
 * `lbsLeft` null (blank) reads as 0. An unticked line is never an action, so any nonzero
 * remainder on it is rejected (never inferred). A ticked line splits only below the
 * vessel's CURRENT measure (re-read under lock by the database).
 */
export function releaseLineIssue(
  ticked: boolean,
  lbsLeft: number | null,
  measure: number,
): string | null {
  if (lbsLeft !== null && !Number.isFinite(lbsLeft)) return LBS_LEFT_NOT_A_NUMBER;
  const left = lbsLeft ?? 0;
  if (left < 0) return LBS_LEFT_NEGATIVE;
  // Hundredths, tolerant of binary float noise (0.29 * 100 = 28.999999999999996).
  if (Math.abs(left * 100 - Math.round(left * 100)) > 1e-6) return LBS_LEFT_TOO_PRECISE;
  if (!ticked) return left === 0 ? null : LBS_LEFT_ON_UNTICKED;
  if (left === 0 || left < measure) return null;
  return LBS_LEFT_NOT_LESS_THAN_MEASURE;
}

/**
 * I4 / I5: the tote tick is the sole action selector. Ticked with Lbs Left 0 (or blank) →
 * full pull; ticked with 0 < Lbs Left < measure → split; unticked → none. Throws on a line
 * `releaseLineIssue` rejects.
 */
export function vesselReleaseAction(
  ticked: boolean,
  lbsLeft: number | null,
  measure: number,
): VesselReleaseAction {
  const issue = releaseLineIssue(ticked, lbsLeft, measure);
  if (issue) throw new RangeError(issue);
  if (!ticked) return "none";
  return (lbsLeft ?? 0) === 0 ? "full_pull" : "split";
}

// Shipment buy / print gate (I13, I13b, I14) ---------------------------------------------

/** `org.settings.shipping.buy_window_days` default: buy iff ship_date ≤ today + 1. */
export const DEFAULT_BUY_WINDOW_DAYS = 1;

/** Blockers the gate itself detects; address / rate blockers come stored on the shipment. */
export const BUY_BLOCKER_MISSING_SHIP_DATE = "missing_ship_date";
export const BUY_BLOCKER_NO_SERVICE = "no_service";

export type BuyGateInput = {
  /** ISO date (YYYY-MM-DD) or null when the box has no ship date yet. */
  shipDate: string | null;
  /** The org's local today, ISO date. */
  today: string;
  buyWindowDays: number;
  /** Manager Buy Now (`force_buy_held`): overrides the date hold only. */
  forceBuyHeld: boolean;
  /** Chosen carrier service, or null when none is selected yet. */
  service: string | null;
  /** Stored blockers (bad address, no rates, …) reported by shipping. */
  blockers: readonly string[];
  labelBought: boolean;
};

export type BuyGate = {
  /** 2+ days out: reported as info, never as an error (I13). */
  held: boolean;
  /** Real blockers, reported alongside `held` — never hidden by it (I13b). */
  blockers: string[];
  canBuy: boolean;
  /** Reprinting an already-bought label is always allowed (purchase hold ≠ print hold). */
  canReprint: boolean;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function shipmentBuyGate(input: BuyGateInput): BuyGate {
  for (const [name, value] of [
    ["today", input.today],
    ["shipDate", input.shipDate ?? input.today],
  ] as const) {
    if (!ISO_DATE.test(value)) throw new RangeError(`${name} must be an ISO date`);
  }
  if (!Number.isInteger(input.buyWindowDays) || input.buyWindowDays < 0) {
    throw new RangeError("buyWindowDays must be a whole number >= 0");
  }
  const blockers = [...new Set(input.blockers)];
  if (input.shipDate === null && !blockers.includes(BUY_BLOCKER_MISSING_SHIP_DATE)) {
    blockers.push(BUY_BLOCKER_MISSING_SHIP_DATE);
  }
  if (!input.service?.trim() && !blockers.includes(BUY_BLOCKER_NO_SERVICE)) {
    blockers.push(BUY_BLOCKER_NO_SERVICE);
  }
  if (input.labelBought) return { held: false, blockers: [], canBuy: false, canReprint: true };
  const held =
    input.shipDate !== null &&
    !input.forceBuyHeld &&
    input.shipDate > addDays(input.today, input.buyWindowDays);
  return { held, blockers, canBuy: !held && blockers.length === 0, canReprint: false };
}
