"use server";

import { createClient } from "@supabase/supabase-js";
import type { Database } from "db";
import { z } from "zod";
import { supabaseEnv } from "@/lib/supabase/env";

const resultSchema = z.object({
  org_name: z.string(),
  timezone: z.string(),
  pickup_hours: z.string(),
  rates_notice: z.string(),
  intakes: z.array(
    z.object({
      number: z.string(),
      state: z.enum(["holding", "processing", "rollstock", "reconcile", "blast_freezer", "stored"]),
      estimated_pickup_at: z.string().nullable(),
      amount_due: z.number(),
    }),
  ),
});
export type StatusResult = { error: string } | z.infer<typeof resultSchema>;

export async function lookupStatus(slug: string, phone: string): Promise<StatusResult> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || phone.length > 80)
    return { error: "Check the phone number and plant link." };
  const env = supabaseEnv();
  // Always anonymous, even when a staff member opens the public page.
  const client = createClient<Database>(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.rpc("customer_status", { p_slug: slug, p_phone: phone });
  if (error) return { error: "Status is temporarily unavailable. Please try again." };
  const parsed = resultSchema.safeParse(data);
  if (parsed.success) return parsed.data;
  const limited =
    typeof data === "object" && data !== null && "error" in data && data.error === "rate_limited";
  return {
    error: limited
      ? "Too many lookups. Please wait a minute and try again."
      : "Check your full phone number, or contact the plant if this link is unavailable.",
  };
}
