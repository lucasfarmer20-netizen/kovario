// Customer phone numbers (docs/02-DOMAIN-MODEL.md §2). `customer.phone` is stored E.164;
// `customer.phone_digits` (generated) holds its digits for search. Typed input is
// normalised here, once, before it reaches the DB (whose check constraint only validates).
//
// Numbers without a `+` are read as NANP (US/Canada, +1): the plants are in Alaska.

/** Digits a search needs before it looks at phones (matches public.search_customers). */
export const MIN_SEARCH_DIGITS = 3;

const E164 = /^\+[1-9]\d{1,14}$/;
const NANP_NATIONAL = /^[2-9]\d{2}[2-9]\d{6}$/;

/** The digits of `raw`, everything else dropped: `(907) 555-1234` → `9075551234`. */
export function phoneDigits(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * E.164 for a typed phone number, or `null` when it is not a complete number.
 *   `(907) 555-1234`, `907.555.1234`, `1-907-555-1234` → `+19075551234`
 *   `+44 20 7946 0958` → `+442079460958` (a leading `+` keeps its country code)
 */
export function normalizePhone(raw: string): string | null {
  const s = raw.trim();
  const digits = phoneDigits(s);
  if (s.startsWith("+")) {
    const e164 = `+${digits}`;
    if (!E164.test(e164) || digits.length < 8) return null;
    if (digits.startsWith("1") && !NANP_NATIONAL.test(digits.slice(1))) return null;
    return e164;
  }
  if (NANP_NATIONAL.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1") && NANP_NATIONAL.test(digits.slice(1))) {
    return `+${digits}`;
  }
  return null;
}

/** Display form: `+19075551234` → `(907) 555-1234`; other numbers stay E.164. */
export function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
