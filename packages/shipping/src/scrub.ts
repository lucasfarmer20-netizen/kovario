// The one scrub function for the Shippo adapter (AGENTS.md hard rule 5): anything shipping
// logs or stores as diagnostics goes through here first.

const SECRET_KEYS = /^(authorization|api_?key|token|shippo_?token|password|secret)$/i;
const TOKEN_TEXT = /(ShippoToken\s+|shippo_(live|test)_)[A-Za-z0-9_]+/g;

export function scrub(value: unknown): unknown {
  if (typeof value === "string") return value.replace(TOKEN_TEXT, "$1[redacted]");
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_KEYS.test(k) ? "[redacted]" : scrub(v),
      ]),
    );
  }
  return value;
}
