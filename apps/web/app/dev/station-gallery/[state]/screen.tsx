"use client";
import { GALLERY_STATES, ReconcileScreen } from "../reconcile-states";
import { FreezerScreen } from "../freezer-states";

export function GalleryScreen({ id }: { id: string }) {
  const state = GALLERY_STATES.find((s) => s.id === id);
  return state ? <ReconcileScreen state={state} /> : <FreezerScreen id={id} />;
}
