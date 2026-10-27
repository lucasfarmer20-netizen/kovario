import { shipmentInput, shippingRoute } from "@/lib/shipping/http";
import { verifyAddress } from "@/lib/shipping/service";

// docs/07-INTEGRATIONS.md §4. Address validate for one shipment → its address blockers.
// Node runtime (never Edge): Shippo calls retry and poll for up to ~30 s.
export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = shippingRoute(shipmentInput, verifyAddress);
