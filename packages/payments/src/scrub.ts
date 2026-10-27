// The shared redaction every adapter's `scrub` builds on (docs/01-ARCHITECTURE.md §9: scrub
// functions are centralised). Secrets are redacted by key; anything that looks like a card
// number (13–19 digits) is masked wherever it appears.

export const REDACTED = "[redacted]";

/** Keys that never reach a log or payment_event (case-insensitive, `_`/`-` ignored). */
const SECRET_KEYS = new Set([
  "authkey",
  "secret",
  "password",
  "apikey",
  "authorization",
  "accesstoken",
  "token",
  "ipostoken",
  "pan",
  "accountnumber",
  "fullcardnumber",
  "cardnumber",
  "cvv",
  "track2",
]);

const PAN = /\b\d(?:[ -]?\d){12,18}\b/g;

function isSecretKey(key: string, extra: ReadonlySet<string>): boolean {
  const k = key.toLowerCase().replace(/[_-]/g, "");
  return SECRET_KEYS.has(k) || extra.has(k);
}

function maskPan(s: string): string {
  return s.replace(PAN, (m) => {
    const digits = m.replace(/\D/g, "");
    return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
  });
}

/**
 * A deep copy of `x` with secret-keyed values replaced by `[redacted]` and card numbers
 * masked to their last four. `extraKeys` adds adapter-specific secret keys.
 */
export function scrubSecrets(x: unknown, extraKeys: readonly string[] = []): unknown {
  const extra = new Set(extraKeys.map((k) => k.toLowerCase().replace(/[_-]/g, "")));
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return maskPan(v);
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = isSecretKey(k, extra) && val !== undefined && val !== null ? REDACTED : walk(val);
    }
    return out;
  };
  return walk(x);
}
