// The shared redaction every adapter's `scrub` builds on (docs/01-ARCHITECTURE.md §9: scrub
// functions are centralised). Secrets are redacted by key — object keys, and `key=value` /
// `"key": "value"` pairs or `Bearer` tokens inside strings (an exception message that echoes
// a request) — and anything that looks like a card number (13–19 digits) is masked wherever
// it appears.

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

/**
 * `key=value`, `key: value`, `"key":"value"` inside a string — also escaped JSON
 * (`{\"key\":\"value\"}`, a body double-encoded into an exception message).
 */
const INLINE_PAIR =
  /(\\?["']?)([A-Za-z][A-Za-z0-9_-]*)\1(\s*[:=]\s*)(\\?"(?:[^"\\]|\\(?!"))*\\?"|'[^']*'|[^\s"'\\,;&}\]]+)/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;

function redactInline(s: string, extra: ReadonlySet<string>): string {
  return s
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(INLINE_PAIR, (match, q: string, key: string, sep: string, value: string) => {
      if (!isSecretKey(key, extra)) return match;
      const vq = value.startsWith('\\"')
        ? '\\"'
        : value[0] === '"' || value[0] === "'"
          ? value[0]
          : "";
      return `${q}${key}${q}${sep}${vq}${REDACTED}${vq}`;
    });
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
    if (typeof v === "string") return maskPan(redactInline(v, extra));
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
