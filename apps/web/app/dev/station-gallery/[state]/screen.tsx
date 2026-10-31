"use client";
import { GALLERY_STATES, ReconcileScreen } from "../reconcile-states";
import { FreezerScreen } from "../freezer-states";
import { WaveGalleryScreen } from "../wave-states";

export function GalleryScreen({ id }: { id: string }) {
  const state = GALLERY_STATES.find((s) => s.id === id);
  if (state) return <ReconcileScreen state={state} />;
  return id.startsWith("wave-") ? <WaveGalleryScreen id={id} /> : <FreezerScreen id={id} />;
}
