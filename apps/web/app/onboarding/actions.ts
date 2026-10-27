"use server";

import type { Json } from "db";
import { redirect } from "next/navigation";
import { referenceSeed } from "rules";
import { z } from "zod";
import type { ActionState } from "@/lib/admin-action";
import { slugify } from "@/lib/onboarding";
import { createSupabaseServer } from "@/lib/supabase/server";

const orgSchema = z.object({
  client_action_id: z.uuid(),
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().toLowerCase().max(40),
  timezone: z.string().min(1).max(64),
  display_name: z.string().trim().min(1).max(80),
  site_name: z.string().trim().min(1).max(80),
});

/**
 * Creates the org for the signed-in account: owner membership, first site, every species,
 * condition, method, matrix and yield row from the processing rules, and the default rate
 * card — one transaction in public.create_org, idempotent per client_action_id. Then the
 * session is refreshed so the access token carries the new org.
 */
export async function createOrganisation(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = orgSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Fill in the plant name, your name and the first site." };
  const d = parsed.data;
  const slug = d.slug || slugify(d.name);

  const supabase = await createSupabaseServer();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims) redirect("/login");

  const { error } = await supabase.rpc("create_org", {
    p_client_action_id: d.client_action_id,
    p_name: d.name,
    p_slug: slug,
    p_timezone: d.timezone,
    p_display_name: d.display_name,
    p_reference: referenceSeed() as unknown as Json,
    p_site_name: d.site_name,
  });
  if (error) return { error: error.message };

  const { error: refreshError } = await supabase.auth.refreshSession();
  if (refreshError) return { error: "Your plant is ready; sign in again to continue." };
  redirect("/onboarding?step=rates");
}
