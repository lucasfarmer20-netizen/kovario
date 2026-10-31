import { BLAST_STATE_IDS, LOCATE_STATE_IDS } from "./freezer-state-ids";
import { ROLLSTOCK_STATE_IDS } from "./rollstock-state-ids";

/**
 * Every station state page: Reconcile's in the order the index shows them (reconcile-states.tsx),
 * then Blast and Locate (freezer-states.tsx), then Rollstock (rollstock-states.tsx).
 */
export const GALLERY_STATE_IDS = [
  "loading",
  "pin",
  "no-order",
  "empty-queue",
  "empty-order",
  "added",
  "weighing",
  "saving",
  "scale-offline",
  "manual-weight",
  "rejected",
  "typed-basket",
  "ready",
  "over-limit",
  "held",
  "suspects",
  "signed-off",
  "offline",
  ...BLAST_STATE_IDS,
  ...LOCATE_STATE_IDS,
  ...ROLLSTOCK_STATE_IDS,
];
