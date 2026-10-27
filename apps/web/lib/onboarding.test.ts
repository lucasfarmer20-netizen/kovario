import { describe, expect, it } from "vitest";
import { onboardingStep, slugify } from "./onboarding";

describe("slugify (org short name)", () => {
  it("lowercases, strips accents and joins words with single dashes", () => {
    expect(slugify("Kenai Fish & Game Co.")).toBe("kenai-fish-game-co");
    expect(slugify("  Ünalakleet  Smokehouse ")).toBe("unalakleet-smokehouse");
    expect(slugify("---")).toBe("");
  });

  it("matches the org.slug constraint and stays within 40 characters", () => {
    const s = slugify("A very long plant name that keeps going and going for ever");
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe("onboardingStep", () => {
  it("an account without an org always starts at the plant step", () => {
    expect(onboardingStep(false, "plan")).toBe("plant");
  });
  it("with an org: the requested step, defaulting to rates", () => {
    expect(onboardingStep(true, undefined)).toBe("rates");
    expect(onboardingStep(true, "device")).toBe("device");
    expect(onboardingStep(true, "plant")).toBe("plant");
    expect(onboardingStep(true, "nonsense")).toBe("rates");
  });
});
