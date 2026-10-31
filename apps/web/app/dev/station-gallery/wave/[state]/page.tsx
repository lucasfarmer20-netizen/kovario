import { notFound } from "next/navigation";
import { WAVE_STATE_IDS } from "../../wave-state-ids";
import { WaveGalleryScreen } from "./screen";

/** One Wave state, full screen (static props, no DB): /dev/station-gallery/wave/scanning. */
export function generateStaticParams() {
  return WAVE_STATE_IDS.map((state) => ({ state }));
}

export default async function WaveGalleryStatePage({
  params,
}: {
  params: Promise<{ state: string }>;
}) {
  const { state } = await params;
  if (!WAVE_STATE_IDS.includes(state)) notFound();
  return <WaveGalleryScreen id={state} />;
}
