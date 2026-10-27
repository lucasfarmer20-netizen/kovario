import { RATE_CARD_EXTRA_KEYS } from "rules";

// Rate cards (docs/02-DOMAIN-MODEL.md §3): the only source of money rates. A line's key is a
// service method code (price per lb) or one of the named rates below.

export const EXTRA_RATE_LABELS: Record<(typeof RATE_CARD_EXTRA_KEYS)[number], string> = {
  ribbing_per_lb: "Ribbing (per lb)",
  fast_pass_per_lb: "Fast Pass floor (per lb)",
  storage_per_box_day: "Cold storage (per box per day)",
};

export const RATE_FIELD_PREFIX = "rate:";

/** `rate:<key>` form fields → admin_set_rate_card_lines lines, or a message. */
export function ratesFromForm(
  form: FormData,
): { lines: { key: string; amount: number }[] } | { error: string } {
  const lines: { key: string; amount: number }[] = [];
  for (const [name, value] of form.entries()) {
    if (!name.startsWith(RATE_FIELD_PREFIX) || typeof value !== "string") continue;
    const key = name.slice(RATE_FIELD_PREFIX.length);
    const raw = value.trim().replace(/^\$/, "");
    const amount = raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(amount) || amount < 0 || amount > 99_999) {
      return { error: `Enter a dollar amount of at least 0 for ${key.replaceAll("_", " ")}.` };
    }
    lines.push({ key, amount: Math.round(amount * 100) / 100 });
  }
  if (lines.length === 0) return { error: "No rates to save." };
  return { lines };
}

/** Rate-card lines in display order: per-lb methods (by method sort) then the named rates. */
export function orderRateLines<T extends { key: string }>(
  lines: T[],
  methods: { code: string; name: string; sort: number }[],
): (T & { label: string })[] {
  const method = new Map(methods.map((m) => [m.code, m]));
  const extras = RATE_CARD_EXTRA_KEYS as readonly string[];
  const rank = (key: string) => {
    const m = method.get(key);
    if (m) return m.sort;
    const i = extras.indexOf(key);
    return i >= 0 ? 1_000_000 + i : 2_000_000;
  };
  return [...lines]
    .sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key))
    .map((l) => ({
      ...l,
      label:
        method.get(l.key)?.name.concat(" (per lb)") ??
        EXTRA_RATE_LABELS[l.key as keyof typeof EXTRA_RATE_LABELS] ??
        l.key,
    }));
}
