// Self-serve onboarding (WP-22): signup → create org (+ reference seed, default rate card,
// first site) → rates → first device → plan (Stripe Checkout).

export const ONBOARDING_STEPS = [
  { key: "plant", label: "Your plant" },
  { key: "rates", label: "Rates" },
  { key: "device", label: "First station" },
  { key: "plan", label: "Plan" },
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]["key"];

/** The step to show: no org yet → plant; otherwise the requested step (default rates). */
export function onboardingStep(hasOrg: boolean, requested: string | undefined): OnboardingStep {
  if (!hasOrg) return "plant";
  const found = ONBOARDING_STEPS.find((s) => s.key === requested);
  return found ? found.key : "rates";
}

/** "Kenai Fish & Game Co." → "kenai-fish-game-co" (org.slug: lowercase words and dashes). */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}
