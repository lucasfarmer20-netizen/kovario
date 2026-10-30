import { encode, parseManual } from "rules";

// Device pairing QR text goes through packages/rules/src/qr.ts like every other QR
// (AGENTS.md hard rule 4): the admin page shows `FL:PAIR:<code>`, which the station
// tablet's scanner types into the focused /pair input.

/** QR text for a pairing code: `FL:PAIR:<code>`. Throws `RangeError` on an invalid code. */
export function pairingQrText(code: string): string {
  return encode("PAIR", { code });
}

/**
 * What a scanner or a person entered on /pair, as a canonical pairing code, or `null`.
 * Accepts a scanned `FL:PAIR:<code>` payload or a typed code (`abcd-2345`), read by
 * rules/qr.ts parseManual like every station's "Enter manually". Any other QR (a tote tag, an
 * asset tag…) is not a pairing code; an all-digit code is a pairing code here, not a tag.
 */
export function readPairingInput(raw: string): string | null {
  const typed = parseManual(raw, { accept: ["PAIR"] });
  return typed.ok && typed.value.kind === "PAIR" ? typed.value.code : null;
}
