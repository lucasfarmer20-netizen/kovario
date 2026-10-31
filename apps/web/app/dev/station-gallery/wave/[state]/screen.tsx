"use client";
import { WAVE_GALLERY_STATES, WaveScreen } from "../../wave-states";

export function WaveGalleryScreen({ id }: { id: string }) {
  const state = WAVE_GALLERY_STATES.find((s) => s.id === id);
  return state ? <WaveScreen state={state} /> : null;
}
