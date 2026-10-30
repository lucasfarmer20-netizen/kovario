import type { Metadata } from "next";
import { StationGallery } from "./gallery";

export const metadata: Metadata = { title: "Station gallery · Filletry" };

/** The floor station design system: tokens, each component in every state, and Reconcile. */
export default function StationGalleryPage() {
  return <StationGallery />;
}
