// Tenant subscription plans (docs/07-INTEGRATIONS.md §5). Tenant billing only — not
// card-present payments. Tiers, prices and gated features are the DECISION-06 default:
//   starter 79 / plant 199 / plant-plus 349 / multi-site 599 / enterprise 899;
//   gates: station count, sites, users, SMS.
// DECISION-06 leaves the numeric limits unspecified; the limits below are placeholders
// kept in this one table so Lucas can change them in one place.

export const PLAN_CODES = ["starter", "plant", "plant-plus", "multi-site", "enterprise"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

/** Count gates (sites, active station devices, members) and the SMS feature flag. */
export type PlanFeature = "sites" | "stations" | "users" | "sms";
export type CountFeature = Exclude<PlanFeature, "sms">;

/** `null` = unlimited. */
export type PlanLimits = Record<CountFeature, number | null> & { sms: boolean };

export interface Plan {
  code: PlanCode;
  name: string;
  monthlyUsd: number;
  limits: PlanLimits;
}

export const PLANS: Readonly<Record<PlanCode, Plan>> = {
  starter: {
    code: "starter",
    name: "Starter",
    monthlyUsd: 79,
    limits: { sites: 1, stations: 3, users: 5, sms: false },
  },
  plant: {
    code: "plant",
    name: "Plant",
    monthlyUsd: 199,
    limits: { sites: 1, stations: 8, users: 15, sms: false },
  },
  "plant-plus": {
    code: "plant-plus",
    name: "Plant Plus",
    monthlyUsd: 349,
    limits: { sites: 2, stations: 15, users: 30, sms: true },
  },
  "multi-site": {
    code: "multi-site",
    name: "Multi-site",
    monthlyUsd: 599,
    limits: { sites: 5, stations: 40, users: 75, sms: true },
  },
  enterprise: {
    code: "enterprise",
    name: "Enterprise",
    monthlyUsd: 899,
    limits: { sites: null, stations: null, users: null, sms: true },
  },
};

/**
 * An org without an active subscription (`org.plan` null) can finish onboarding — the
 * site create_org makes, one station device, the owner plus one member — and nothing more.
 */
export const NO_PLAN_LIMITS: PlanLimits = { sites: 1, stations: 1, users: 2, sms: false };

export function isPlanCode(value: unknown): value is PlanCode {
  return typeof value === "string" && (PLAN_CODES as readonly string[]).includes(value);
}

/** Stripe Price `lookup_key` of a plan's monthly price; the webhook maps it back. */
export const LOOKUP_KEY_PREFIX = "filletry-";

export function lookupKey(plan: PlanCode): string {
  return `${LOOKUP_KEY_PREFIX}${plan}`;
}

export function planFromLookupKey(key: string | null | undefined): PlanCode | null {
  if (!key?.startsWith(LOOKUP_KEY_PREFIX)) return null;
  const code = key.slice(LOOKUP_KEY_PREFIX.length);
  return isPlanCode(code) ? code : null;
}

export function limitsFor(plan: string | null | undefined): PlanLimits {
  return isPlanCode(plan) ? PLANS[plan].limits : NO_PLAN_LIMITS;
}

/** Current counts of the gated things in an org. */
export type PlanUsage = Record<CountFeature, number>;

export type PlanCheck =
  | { ok: true }
  | {
      ok: false;
      feature: PlanFeature;
      /** The cheapest plan that would allow it, or null when none does. */
      upgradeTo: PlanCode | null;
      message: string;
    };

const FEATURE_LABEL: Record<PlanFeature, [one: string, many: string]> = {
  sites: ["site", "sites"],
  stations: ["station device", "station devices"],
  users: ["user", "users"],
  sms: ["SMS notifications", "SMS notifications"],
};

function allows(limits: PlanLimits, feature: PlanFeature, usage: PlanUsage): boolean {
  if (feature === "sms") return limits.sms;
  const limit = limits[feature];
  return limit === null || usage[feature] < limit;
}

/**
 * Whether `plan` allows the feature — for count gates, adding ONE more on top of `usage`.
 * Gates only ever block adding; an org above its limit (e.g. after a downgrade) keeps what
 * it has.
 */
export function checkPlan(
  plan: string | null | undefined,
  feature: PlanFeature,
  usage: PlanUsage,
): PlanCheck {
  const limits = limitsFor(plan);
  if (allows(limits, feature, usage)) return { ok: true };
  const upgradeTo = PLAN_CODES.find((c) => allows(PLANS[c].limits, feature, usage)) ?? null;
  const current = isPlanCode(plan)
    ? `The ${PLANS[plan].name} plan`
    : "Without a subscription, Filletry";
  const [one, many] = FEATURE_LABEL[feature];
  const limit = feature === "sms" ? null : limits[feature];
  const detail =
    feature === "sms"
      ? `${current} does not include ${many}.`
      : `${current} allows ${limit} ${limit === 1 ? one : many}.`;
  const upgrade = upgradeTo ? ` Upgrade to ${PLANS[upgradeTo].name} in Subscription.` : "";
  return { ok: false, feature, upgradeTo, message: detail + upgrade };
}

/** Stripe subscription statuses that keep the plan active (past_due: Stripe is retrying). */
export const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due"] as const;
