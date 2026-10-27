// Shippo tracking webhook (`track_updated`) → shipment state (docs/07-INTEGRATIONS.md §4).
// Shippo does not sign webhooks, so the endpoint URL carries a shared token
// (`?token=…`, env SHIPPO_WEBHOOK_TOKEN) compared in constant time.
import type { TrackingStatus, TrackingUpdate } from "./types.ts";

const STATUSES: readonly TrackingStatus[] = [
  "PRE_TRANSIT",
  "TRANSIT",
  "DELIVERED",
  "RETURNED",
  "FAILURE",
  "UNKNOWN",
];

/** The carrier has the box: the shipment moves `label_bought → shipped`. */
export function isInCarrierHands(status: TrackingStatus): boolean {
  return status === "TRANSIT" || status === "DELIVERED";
}

/** Something went wrong after pickup: surfaced on the queue, never auto-resolved. */
export function isCarrierException(status: TrackingStatus): boolean {
  return status === "RETURNED" || status === "FAILURE";
}

/** The `track_updated` payload, or null for any other event / malformed body. */
export function parseTrackingEvent(body: unknown): TrackingUpdate | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.event !== "track_updated") return null;
  const d = b.data as Record<string, unknown> | undefined;
  if (!d || typeof d !== "object") return null;
  const ts = (d.tracking_status ?? {}) as Record<string, unknown>;
  const trackingNumber = typeof d.tracking_number === "string" ? d.tracking_number.trim() : "";
  const raw = typeof ts.status === "string" ? ts.status.toUpperCase() : "UNKNOWN";
  if (!trackingNumber) return null;
  return {
    carrier: typeof d.carrier === "string" ? d.carrier : "",
    trackingNumber,
    transactionId: typeof d.transaction === "string" ? d.transaction : null,
    status: (STATUSES as readonly string[]).includes(raw) ? (raw as TrackingStatus) : "UNKNOWN",
    statusDate: typeof ts.status_date === "string" ? ts.status_date : null,
    details: typeof ts.status_details === "string" ? ts.status_details.slice(0, 500) : null,
    test: b.test === true,
  };
}

/** Constant-time string compare (no early exit on the first differing byte). */
export function tokensMatch(
  given: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!given || !expected) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
