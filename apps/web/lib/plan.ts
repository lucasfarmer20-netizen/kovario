import type { FilletryClient } from "db";
import { checkPlan, type PlanCheck, type PlanFeature, type PlanUsage } from "payments";
import { createSupabaseServer } from "./supabase/server";

/** Thrown by requirePlan; its message is shown to the user (admin forms surface it). */
export class PlanLimitError extends Error {
  constructor(readonly check: Extract<PlanCheck, { ok: false }>) {
    super(check.message);
    this.name = "PlanLimitError";
  }
}

async function count(query: PromiseLike<{ count: number | null; error: unknown }>) {
  const { count: n, error } = await query;
  if (error) throw new Error("Could not read plan usage.");
  return n ?? 0;
}

/** The org's plan and its usage of the gated things, read with the caller's session (RLS). */
export async function planState(
  supabase: FilletryClient,
): Promise<{ plan: string | null; usage: PlanUsage }> {
  const head = { count: "exact", head: true } as const;
  const [org, sites, stations, users] = await Promise.all([
    supabase.from("org").select("plan").maybeSingle(),
    count(supabase.from("site").select("id", head)),
    count(supabase.from("device").select("id", head).eq("is_active", true)),
    count(supabase.from("org_member").select("id", head)),
  ]);
  if (org.error) throw new Error("Could not read the subscription plan.");
  return { plan: org.data?.plan ?? null, usage: { sites, stations, users } };
}

/**
 * Feature gate (docs/07-INTEGRATIONS.md §5: feature gates read `org.plan`). Resolves when
 * the org's plan allows `feature` — for sites/stations/users, adding one more — and throws
 * PlanLimitError naming the plan to upgrade to otherwise. Call it before the mutation.
 */
export async function requirePlan(feature: PlanFeature, supabase?: FilletryClient): Promise<void> {
  const client = supabase ?? (await createSupabaseServer());
  const { plan, usage } = await planState(client);
  const check = checkPlan(plan, feature, usage);
  if (!check.ok) throw new PlanLimitError(check);
}
