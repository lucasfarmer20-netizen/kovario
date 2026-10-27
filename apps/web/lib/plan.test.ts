import type { FilletryClient } from "db";
import { describe, expect, it, vi } from "vitest";

vi.mock("./supabase/server", () => ({ createSupabaseServer: vi.fn() }));

import { PlanLimitError, requirePlan } from "./plan";

/** A stand-in for the RLS-scoped client: one org row and per-table counts. */
function fakeClient(plan: string | null, counts: Record<string, number>): FilletryClient {
  const from = (table: string) => {
    const result = { count: counts[table] ?? 0, error: null };
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: { plan }, error: null }),
      then: (resolve: (v: typeof result) => unknown) => Promise.resolve(result).then(resolve),
    };
    return query;
  };
  return { from } as unknown as FilletryClient;
}

describe("requirePlan(feature)", () => {
  it("passes while the plan allows one more", async () => {
    const client = fakeClient("plant", { site: 1, device: 7, org_member: 3 });
    await expect(requirePlan("stations", client)).resolves.toBeUndefined();
  });

  it("throws PlanLimitError with the upgrade when the limit is reached", async () => {
    const client = fakeClient("plant", { site: 1, device: 8, org_member: 3 });
    const err = await requirePlan("stations", client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanLimitError);
    expect((err as PlanLimitError).check.upgradeTo).toBe("plant-plus");
    expect((err as Error).message).toBe(
      "The Plant plan allows 8 station devices. Upgrade to Plant Plus in Subscription.",
    );
  });

  it("an unsubscribed org can add its first device but not a second site", async () => {
    const client = fakeClient(null, { site: 1, device: 0, org_member: 1 });
    await expect(requirePlan("stations", client)).resolves.toBeUndefined();
    await expect(requirePlan("sites", client)).rejects.toBeInstanceOf(PlanLimitError);
  });

  it("gates SMS on the plan alone", async () => {
    await expect(requirePlan("sms", fakeClient("starter", {}))).rejects.toThrow(/SMS/);
    await expect(requirePlan("sms", fakeClient("enterprise", {}))).resolves.toBeUndefined();
  });
});
