// QR payloads (docs/02-DOMAIN-MODEL.md §13). The ONLY producer and parser of QR text:
// every label template and every scan handler imports from here.
//
//   Tote tag     FL:TOTE:<INT-0001>:<n>
//   Asset tag    FL:TAG:<org_slug>:<042>
//   Location     FL:LOC:<org_slug>:<IF-A-01-1-F>
//   Boxing token FL:BOX:<settlement.boxing_token>
//   Storage box  FL:SBOX:<STG-0001>:<n>
//   Pairing      FL:PAIR:<code>   one-time device pairing code (8 chars, see PAIRING_ALPHABET),
//                                 scanned at /pair by the station tablet's scanner
//
// Scan handlers also accept the bare legacy forms `INT-0001` (a tote of that intake) and
// `042` / `42` (an asset tag), with asset-tag padding normalised. A pairing code has no bare
// legacy form: only /pair accepts a typed code (via normalizePairingCode), so an 8-character
// scan at a station is never mistaken for one.

export const QR_PREFIX = "FL";
export const QR_KINDS = ["TOTE", "TAG", "LOC", "BOX", "SBOX", "PAIR"] as const;
export type QrKind = (typeof QR_KINDS)[number];

/**
 * Characters of a pairing code: no 0/O, 1/I/L or U. Must match the alphabet in
 * public.admin_device_pairing_code (supabase/migrations/*_devices_pins.sql).
 */
export const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;

/** Canonical asset-tag width (`org.settings.scanner.tag_digits`). */
export const TAG_DIGITS = 3;

export interface QrOptions {
  /** The org's `scanner.tag_digits`; defaults to {@link TAG_DIGITS}. */
  tagDigits?: number;
}

export interface QrFields {
  TOTE: { intakeNumber: string; toteNo: number };
  TAG: { orgSlug: string; code: string };
  LOC: { orgSlug: string; code: string };
  BOX: { token: string };
  SBOX: { storageNumber: string; boxNo: number };
  PAIR: { code: string };
}

export type QrPayload = { [K in QrKind]: { kind: K } & QrFields[K] }[QrKind];

export type ParsedQr =
  | (QrPayload & { legacy: false })
  | { kind: "TOTE"; intakeNumber: string; toteNo: null; legacy: true }
  | { kind: "TAG"; orgSlug: null; code: string; legacy: true };

export type QrRejectReason = "empty" | "unknown_format" | "bad_field";

export type ParseResult = { ok: true; value: ParsedQr } | { ok: false; reason: QrRejectReason };

const INTAKE_NUMBER = /^INT-\d{4,}$/;
const STORAGE_NUMBER = /^STG-\d{4,}$/;
const ORG_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOCATION_CODE = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const BOXING_TOKEN = /^[A-Za-z0-9_-]+$/;
const POSITIVE_INT = /^[1-9]\d*$/;
const DIGITS = /^\d+$/;
const PAIRING_CODE = new RegExp(`^[${PAIRING_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`);

/**
 * Canonical asset-tag code: `42` / `042` / `0042` → `042`. `null` when the input is not
 * all digits. A normalised code is not evidence the tag exists — callers still look it up.
 */
export function normalizeTagCode(raw: string, digits: number = TAG_DIGITS): string | null {
  const s = raw.trim();
  if (!DIGITS.test(s)) return null;
  return s.replace(/^0+(?=\d)/, "").padStart(digits, "0");
}

/**
 * Canonical pairing code: whitespace and dashes removed, upper-cased (`abcd-2345` →
 * `ABCD2345`). `null` unless it is exactly PAIRING_CODE_LENGTH characters of
 * PAIRING_ALPHABET. A valid code is not evidence it is live — the server redeems it.
 */
export function normalizePairingCode(raw: string): string | null {
  const s = raw.replace(/[\s-]/g, "").toUpperCase();
  return PAIRING_CODE.test(s) ? s : null;
}

function positiveInt(s: string): number | null {
  if (!POSITIVE_INT.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

function field(name: string, value: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new RangeError(`QR ${name} is invalid: ${JSON.stringify(value)}`);
  return value;
}

function count(name: string, value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`QR ${name} must be a positive integer`);
  }
  return String(value);
}

function pairingCode(code: string): string {
  const canonical = normalizePairingCode(code);
  if (canonical === null)
    throw new RangeError(`QR pairing code is invalid: ${JSON.stringify(code)}`);
  return canonical;
}

function tagCode(code: string, digits: number): string {
  const canonical = normalizeTagCode(code, digits);
  if (canonical === null) throw new RangeError(`QR tag code is invalid: ${JSON.stringify(code)}`);
  return canonical;
}

const ENCODERS: { [K in QrKind]: (f: QrFields[K], tagDigits: number) => string[] } = {
  TOTE: (f) => [field("intake number", f.intakeNumber, INTAKE_NUMBER), count("tote no", f.toteNo)],
  TAG: (f, digits) => [field("org slug", f.orgSlug, ORG_SLUG), tagCode(f.code, digits)],
  LOC: (f) => [
    field("org slug", f.orgSlug, ORG_SLUG),
    field("location code", f.code, LOCATION_CODE),
  ],
  BOX: (f) => [field("boxing token", f.token, BOXING_TOKEN)],
  SBOX: (f) => [field("storage number", f.storageNumber, STORAGE_NUMBER), count("box no", f.boxNo)],
  PAIR: (f) => [pairingCode(f.code)],
};

/** QR text for a label. Throws `RangeError` on a field that would not parse back. */
export function encode<K extends QrKind>(
  kind: K,
  fields: QrFields[K],
  options: QrOptions = {},
): string {
  return [QR_PREFIX, kind, ...ENCODERS[kind](fields, options.tagDigits ?? TAG_DIGITS)].join(":");
}

const DECODERS: { [K in QrKind]: (parts: string[], tagDigits: number) => QrFields[K] | null } = {
  TOTE: ([intakeNumber = "", tote = ""]) => {
    const toteNo = positiveInt(tote);
    return INTAKE_NUMBER.test(intakeNumber) && toteNo !== null ? { intakeNumber, toteNo } : null;
  },
  TAG: ([orgSlug = "", raw = ""], digits) => {
    const code = normalizeTagCode(raw, digits);
    return ORG_SLUG.test(orgSlug) && code !== null ? { orgSlug, code } : null;
  },
  LOC: ([orgSlug = "", code = ""]) =>
    ORG_SLUG.test(orgSlug) && LOCATION_CODE.test(code) ? { orgSlug, code } : null,
  BOX: ([token = ""]) => (BOXING_TOKEN.test(token) ? { token } : null),
  SBOX: ([storageNumber = "", box = ""]) => {
    const boxNo = positiveInt(box);
    return STORAGE_NUMBER.test(storageNumber) && boxNo !== null ? { storageNumber, boxNo } : null;
  },
  PAIR: ([raw = ""]) => {
    // Scanned payloads hold no dashes or spaces; only letter case is normalised here.
    const code = raw.toUpperCase();
    return PAIRING_CODE.test(code) ? { code } : null;
  },
};

const ARITY: Record<QrKind, number> = { TOTE: 2, TAG: 2, LOC: 2, BOX: 1, SBOX: 2, PAIR: 1 };

function isQrKind(value: string): value is QrKind {
  return (QR_KINDS as readonly string[]).includes(value);
}

/** Parse scanned text. Never throws; the reason goes to `scan_log` on rejection. */
export function parse(raw: string, options: QrOptions = {}): ParseResult {
  const digits = options.tagDigits ?? TAG_DIGITS;
  // Keyboard-wedge scanners may append CR/LF or tabs.
  const text = raw.trim();
  if (text === "") return { ok: false, reason: "empty" };

  const [prefix, kind, ...rest] = text.split(":");
  if (prefix === QR_PREFIX && kind !== undefined && isQrKind(kind)) {
    const fields = rest.length === ARITY[kind] ? DECODERS[kind](rest, digits) : null;
    if (fields === null) return { ok: false, reason: "bad_field" };
    return { ok: true, value: { kind, ...fields, legacy: false } as ParsedQr };
  }

  if (INTAKE_NUMBER.test(text)) {
    return { ok: true, value: { kind: "TOTE", intakeNumber: text, toteNo: null, legacy: true } };
  }
  const code = normalizeTagCode(text, digits);
  if (code !== null) {
    return { ok: true, value: { kind: "TAG", orgSlug: null, code, legacy: true } };
  }
  return { ok: false, reason: "unknown_format" };
}
