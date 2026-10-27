"use server";

import type { Json } from "db";
import { revalidatePath } from "next/cache";
import { referenceSeed } from "rules";
import { z } from "zod";
import { adminMutation, unwrap, type ActionState } from "@/lib/admin-action";

const checkbox = z.literal("on").optional();

const speciesSchema = z.object({
  species_id: z.uuid(),
  name: z.string().trim().min(1).max(80),
  shorthand: z.string().trim().toUpperCase().max(6),
  sort: z.coerce.number().int().min(0).max(100_000),
  is_active: checkbox,
});

export async function updateSpecies(_state: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = speciesSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success)
    return { error: "Enter a name, a shorthand of up to 6 characters and a sort." };
  const d = parsed.data;
  const result = await adminMutation(
    formData,
    async ({ supabase }, id) =>
      unwrap(
        await supabase.rpc("admin_update_species", {
          p_client_action_id: id,
          p_species_id: d.species_id,
          p_name: d.name,
          p_shorthand: d.shorthand,
          p_sort: d.sort,
          p_is_active: d.is_active === "on",
        }),
      ),
    `Saved ${d.name}.`,
  );
  revalidatePath("/admin/species");
  return result;
}

const methodSchema = z.object({
  method_id: z.uuid(),
  name: z.string().trim().min(1).max(80),
  is_active: checkbox,
  lodge_cappable: checkbox,
});

export async function updateMethod(_state: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = methodSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Enter a method name." };
  const d = parsed.data;
  const result = await adminMutation(
    formData,
    async ({ supabase }, id) =>
      unwrap(
        await supabase.rpc("admin_update_processing_method", {
          p_client_action_id: id,
          p_method_id: d.method_id,
          p_name: d.name,
          p_is_active: d.is_active === "on",
          p_lodge_cappable: d.lodge_cappable === "on",
        }),
      ),
    `Saved ${d.name}.`,
  );
  revalidatePath("/admin/species");
  return result;
}

/** Adds any species, conditions, methods, matrix or yield rows from the processing rules
 *  that this org lacks (existing rows and edits are kept), plus the default rate card. */
export async function seedReference(_state: ActionState, formData: FormData): Promise<ActionState> {
  const result = await adminMutation(
    formData,
    async ({ supabase }, id) =>
      unwrap(
        await supabase.rpc("admin_seed_reference", {
          p_client_action_id: id,
          p_reference: referenceSeed() as unknown as Json,
        }),
      ),
    "Processing rules are up to date.",
  );
  revalidatePath("/admin/species");
  revalidatePath("/admin/rate-cards");
  return result;
}
