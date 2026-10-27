import { buyInput, shippingRoute } from "@/lib/shipping/http";
import { buyLabel } from "@/lib/shipping/service";

// docs/07-INTEGRATIONS.md §4. Buy the label(s): I13 / I13b / I14 gate + claim, one Shippo transaction per parcel, every label fetched.
// Node runtime (never Edge): Shippo calls retry and poll for up to ~30 s.
export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = shippingRoute(buyInput, buyLabel);
