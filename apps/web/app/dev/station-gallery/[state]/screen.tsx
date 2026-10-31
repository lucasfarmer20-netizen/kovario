"use client";
import { GALLERY_STATES, ReconcileScreen } from "../reconcile-states";
import { FreezerScreen } from "../freezer-states";
import { WaveGalleryScreen } from "../wave-states";
import { ROLLSTOCK_STATES, RollstockScreen } from "../rollstock-states";
import { BoxingGalleryScreen } from "../boxing-states";
import { DeskScreen } from "../desk-states";

export function GalleryScreen({ id }: { id: string }) {
  const state = GALLERY_STATES.find((s) => s.id === id);
  if (state) return <ReconcileScreen state={state} />;
  const rollstock = ROLLSTOCK_STATES.find((s) => s.id === id);
  if (rollstock) return <RollstockScreen state={rollstock} />;
  if (id.startsWith("wave-")) return <WaveGalleryScreen id={id} />;
  if (id.startsWith("boxing-")) return <BoxingGalleryScreen id={id} />;
  if (id.startsWith("intake-") || id.startsWith("storage-")) return <DeskScreen id={id} />;
  return <FreezerScreen id={id} />;
}
