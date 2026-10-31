"use client";
import { GALLERY_STATES, ReconcileScreen } from "../reconcile-states";
import { FreezerScreen } from "../freezer-states";
import { ROLLSTOCK_STATES, RollstockScreen } from "../rollstock-states";

export function GalleryScreen({ id }: { id: string }) {
  const state = GALLERY_STATES.find((s) => s.id === id);
  if (state) return <ReconcileScreen state={state} />;
  const rollstock = ROLLSTOCK_STATES.find((s) => s.id === id);
  if (rollstock) return <RollstockScreen state={rollstock} />;
  return <FreezerScreen id={id} />;
}
