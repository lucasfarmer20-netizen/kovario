import type { StateOf } from "./states";

/** §13: public stages deliberately reveal no floor details. null means not public. */
export const CUSTOMER_STAGES: Readonly<Record<StateOf<"intake">, string | null>> = {
  draft: null,
  holding: "In cooler",
  processing: "Processing",
  rollstock: "Processing",
  reconcile: "Processing",
  blast_freezer: "Freezing",
  stored: "Ready for pickup",
  done: null,
  cancelled: null,
};
