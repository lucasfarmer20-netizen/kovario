import { notFound } from "next/navigation";
import { GALLERY_STATE_IDS } from "../state-ids";
import { GalleryScreen } from "./screen";

/** One station state, full screen (static props, no DB): /dev/station-gallery/held. */
export function generateStaticParams() {
  return GALLERY_STATE_IDS.map((state) => ({ state }));
}

export default async function GalleryStatePage({ params }: { params: Promise<{ state: string }> }) {
  const { state } = await params;
  if (!GALLERY_STATE_IDS.includes(state)) notFound();
  return <GalleryScreen id={state} />;
}
