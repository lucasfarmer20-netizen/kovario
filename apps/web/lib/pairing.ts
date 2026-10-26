/**
 * The URL a pairing QR encodes. It is opened by the tablet's camera app, never scanned by a
 * station's <ScanInput>, so it is a plain URL rather than a `KV:` payload from
 * packages/rules/src/qr.ts.
 */
export function pairingUrl(origin: string, code: string): string {
  const url = new URL("/pair", origin);
  url.searchParams.set("code", code);
  return url.toString();
}

/** Pairing codes: 8 characters from the unambiguous alphabet (no 0/O, 1/I/L, U). */
export const PAIRING_CODE_PATTERN = /^[A-HJKMNP-TV-Z2-9]{8}$/;

export function normalisePairingCode(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}
