import { rateCheckInput, shippingRoute } from "@/lib/shipping/http";
import { rateCheck } from "@/lib/shipping/service";

// docs/07-INTEGRATIONS.md §4. Rate Check / freight quote: any address and parcels, nothing stored, nothing bought.
// Node runtime (never Edge): Shippo calls retry and poll for up to ~30 s.
export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = shippingRoute(rateCheckInput, rateCheck);
