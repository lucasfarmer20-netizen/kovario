import { MIN_SEARCH_DIGITS, QR_PREFIX, normalizePhone, phoneDigits } from "rules";

/** One row of public.search_customers: what the dropdown shows (docs/06-STATIONS-UX.md). */
export type CustomerHit = {
  id: string;
  name: string;
  phone: string | null;
  last_visit_at: string | null;
  is_lodge_guest: boolean;
  lodge_id: string | null;
  lodge_name: string | null;
};

export type CreateCustomerInput = { clientActionId: string; name: string; phone: string };
export type CreateCustomerResult = { customer?: CustomerHit; error?: string };

/** Letters a name search needs (public.search_customers' name fallback). */
export const MIN_NAME_LETTERS = 3;

// Keyboard-wedge scanners type a whole code in a few ms per character, then Enter.
// People do not sustain < 35 ms between keys over 4+ characters.
export const SCAN_MAX_GAP_MS = 35;
export const SCAN_MIN_CHARS = 4;

/** A scanned QR payload (packages/rules qr.ts) rather than a phone or name. */
function looksLikeQr(q: string): boolean {
  return q.trim().toUpperCase().startsWith(`${QR_PREFIX}:`);
}

/**
 * Whether `q` is worth a request: the server answers anything (and returns no rows below
 * its thresholds), so this only spares round trips while someone is still typing.
 */
export function canSearch(q: string): boolean {
  if (looksLikeQr(q)) return false;
  if (phoneDigits(q).length >= MIN_SEARCH_DIGITS) return true;
  return q.replace(/[^\p{L}]/gu, "").length >= MIN_NAME_LETTERS;
}

/**
 * What the dropdown may show and Enter/click may pick. Only results answered for exactly the
 * current query count: while a newer query is debouncing or in flight, or after its request
 * failed, the previous query's customers are not selectable.
 */
export function searchOptions(
  hits: CustomerHit[],
  searched: string | null,
  query: string,
  canCreate: boolean,
): { hits: CustomerHit[]; create: boolean } {
  if (searched === null || searched !== query) return { hits: [], create: false };
  return { hits, create: canCreate };
}

/** Next highlighted option, wrapping at both ends; -1 when there is nothing to highlight. */
export function moveHighlight(current: number, count: number, delta: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/** Inline-create defaults from what was typed: digits prefill the phone, text the name. */
export function createDraft(q: string): { name: string; phone: string } {
  const s = q.trim();
  return phoneDigits(s).length >= MIN_SEARCH_DIGITS
    ? { name: "", phone: s }
    : { name: s, phone: "" };
}

/** Validates the inline-create form; returns the E.164 phone ("" for none) or an error. */
export function validateDraft(draft: {
  name: string;
  phone: string;
}): { ok: true; name: string; phone: string } | { ok: false; error: string } {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: "Enter the customer's name." };
  if (!draft.phone.trim()) return { ok: true, name, phone: "" };
  const phone = normalizePhone(draft.phone);
  if (!phone) return { ok: false, error: "Enter a full phone number, e.g. (907) 555-1234." };
  return { ok: true, name, phone };
}

/**
 * Tracks keystroke timing in the search box so a scanner burst + Enter is told apart from a
 * person pressing Enter on a highlighted customer.
 */
export class KeystrokeTimer {
  private times: number[] = [];

  key(at: number): void {
    this.times.push(at);
  }

  reset(): void {
    this.times = [];
  }

  /** True when the whole current entry arrived as one fast burst. */
  isBurst(): boolean {
    if (this.times.length < SCAN_MIN_CHARS) return false;
    return this.times.every((t, i) => i === 0 || t - (this.times[i - 1] ?? t) <= SCAN_MAX_GAP_MS);
  }

  /** Whether Enter on `value` ends a scan (forward it) rather than a choice in the list. */
  isScan(value: string): boolean {
    return looksLikeQr(value) || this.isBurst();
  }
}
