import { BLAST_STATE_IDS, LOCATE_STATE_IDS } from "./freezer-state-ids";
import { WAVE_STATE_IDS } from "./wave-state-ids";
import { ROLLSTOCK_STATE_IDS } from "./rollstock-state-ids";
import { INTAKE_STATE_IDS, STORAGE_STATE_IDS } from "./desk-state-ids";

/**
 * Every station state page: Reconcile's in the order the index shows them (reconcile-states.tsx),
 * then Blast and Locate (freezer-states.tsx), Wave (wave-states.tsx), Rollstock
 * (rollstock-states.tsx), and the keyboard stations Intake and Storage intake (desk-states.tsx).
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
  ...WAVE_STATE_IDS,
  ...ROLLSTOCK_STATE_IDS,
  ...INTAKE_STATE_IDS,
  ...STORAGE_STATE_IDS,
];
