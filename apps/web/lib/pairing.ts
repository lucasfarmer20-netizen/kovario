import { encode, normalizePairingCode, parse } from "rules";

// Device pairing QR text goes through packages/rules/src/qr.ts like every other QR
// (AGENTS.md hard rule 4): the admin page shows `FL:PAIR:<code>`, which the station
// tablet's scanner types into the focused /pair input.

/** QR text for a pairing code: `FL:PAIR:<code>`. Throws `RangeError` on an invalid code. */
export function pairingQrText(code: string): string {
  return encode("PAIR", { code });
}

/**
 * What a scanner or a person entered on /pair, as a canonical pairing code, or `null`.
 * Accepts a scanned `FL:PAIR:<code>` payload or a typed code (`abcd-2345`). Any other QR
 * (a tote tag, an asset tag…) is not a pairing code.
 */
export function readPairingInput(raw: string): string | null {
  const scanned = parse(raw);
  if (scanned.ok && scanned.value.kind === "PAIR") return scanned.value.code;
  // Typed codes have no FL: wrapper. An all-digit code (e.g. 23456789) parses as a legacy
  // asset tag, so fall through to the typed-code rule for anything that is not FL:PAIR.
  return normalizePairingCode(raw);
}
