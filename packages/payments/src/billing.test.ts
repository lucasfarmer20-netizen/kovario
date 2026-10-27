import { describe, expect, it } from "vitest";
import {
  NO_PLAN_LIMITS,
  PLAN_CODES,
  PLANS,
  checkPlan,
  limitsFor,
  lookupKey,
  planFromLookupKey,
} from "./billing.ts";

const usage = (sites = 0, stations = 0, users = 0) => ({ sites, stations, users });

describe("plan catalogue (DECISION-06 default)", () => {
  it("has the five placeholder tiers at $79–$899, cheapest first", () => {
    expect(PLAN_CODES).toEqual(["starter", "plant", "plant-plus", "multi-site", "enterprise"]);
    expect(PLAN_CODES.map((c) => PLANS[c].monthlyUsd)).toEqual([79, 199, 349, 599, 899]);
  });

  it("limits never shrink going up a tier", () => {
    for (let i = 1; i < PLAN_CODES.length; i++) {
      const lower = PLANS[PLAN_CODES[i - 1]!].limits;
      const upper = PLANS[PLAN_CODES[i]!].limits;
      for (const f of ["sites", "stations", "users"] as const) {
        const u = upper[f] ?? Infinity;
        expect(u).toBeGreaterThanOrEqual(lower[f] ?? Infinity);
      }
      expect(!lower.sms || upper.sms).toBe(true);
    }
  });

  it("maps plans to Stripe lookup keys and back; rejects foreign keys", () => {
    for (const c of PLAN_CODES) expect(planFromLookupKey(lookupKey(c))).toBe(c);
    expect(planFromLookupKey("filletry-gold")).toBeNull();
    expect(planFromLookupKey("starter")).toBeNull();
    expect(planFromLookupKey(null)).toBeNull();
  });

  it("an org without a plan gets the onboarding-only limits", () => {
    expect(limitsFor(null)).toBe(NO_PLAN_LIMITS);
    expect(limitsFor("unknown")).toBe(NO_PLAN_LIMITS);
    expect(limitsFor("plant")).toBe(PLANS.plant.limits);
  });
});

describe("checkPlan (requirePlan's rule)", () => {
  it("allows adding while under the limit and blocks at the limit", () => {
    expect(checkPlan("starter", "stations", usage(1, 2, 1))).toEqual({ ok: true });
    const denied = checkPlan("starter", "stations", usage(1, 3, 1));
    expect(denied).toMatchObject({ ok: false, feature: "stations", upgradeTo: "plant" });
  });

  it("names the cheapest plan that allows the next one", () => {
    expect(checkPlan("starter", "sites", usage(1))).toMatchObject({ upgradeTo: "plant-plus" });
    expect(checkPlan("plant", "users", usage(1, 1, 75))).toMatchObject({ upgradeTo: "enterprise" });
  });

  it("enterprise is unlimited", () => {
    expect(checkPlan("enterprise", "sites", usage(10_000, 10_000, 10_000))).toEqual({ ok: true });
  });

  it("SMS is a feature flag, not a count", () => {
    expect(checkPlan("plant", "sms", usage())).toMatchObject({ ok: false, upgradeTo: "plant-plus" });
    expect(checkPlan("plant-plus", "sms", usage())).toEqual({ ok: true });
    expect(checkPlan(null, "sms", usage())).toMatchObject({ ok: false });
  });

  it("no plan: the first device is allowed, the second needs a subscription", () => {
    expect(checkPlan(null, "stations", usage(1, 0, 1))).toEqual({ ok: true });
    const denied = checkPlan(null, "stations", usage(1, 1, 1));
    expect(denied).toMatchObject({ ok: false, upgradeTo: "starter" });
    if (!denied.ok) expect(denied.message).toMatch(/Without a subscription.*1 station device\./);
  });

  it("an org above its limit after a downgrade is only blocked from adding", () => {
    expect(checkPlan("starter", "sites", usage(3))).toMatchObject({ ok: false });
    expect(checkPlan("starter", "stations", usage(3, 0, 0))).toEqual({ ok: true });
  });
});
