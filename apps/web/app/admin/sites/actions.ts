"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminMutation, unwrap, type ActionState } from "@/lib/admin-action";
import { requirePlan } from "@/lib/plan";

const nameSchema = z.object({ name: z.string().trim().min(1).max(80) });

export async function createSite(_state: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = nameSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Enter a site name." };
  const result = await adminMutation(
    formData,
    async ({ supabase }, id) => {
      await requirePlan("sites", supabase);
      return unwrap(
        await supabase.rpc("admin_create_site", {
          p_client_action_id: id,
          p_name: parsed.data.name,
        }),
      );
    },
    `Added ${parsed.data.name}.`,
  );
  revalidatePath("/admin/sites");
  return result;
}

const renameSchema = z.object({ site_id: z.uuid(), name: z.string().trim().min(1).max(80) });

export async function renameSite(_state: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = renameSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Enter a site name." };
  const result = await adminMutation(
    formData,
    async ({ supabase }, id) =>
      unwrap(
        await supabase.rpc("admin_rename_site", {
          p_client_action_id: id,
          p_site_id: parsed.data.site_id,
          p_name: parsed.data.name,
        }),
      ),
    "Saved.",
  );
  revalidatePath("/admin/sites");
  return result;
}

const defaultSchema = z.object({ site_id: z.uuid() });

export async function makeDefaultSite(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = defaultSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Unknown site." };
  const result = await adminMutation(
    formData,
    async ({ supabase }, id) =>
      unwrap(
        await supabase.rpc("admin_set_default_site", {
          p_client_action_id: id,
          p_site_id: parsed.data.site_id,
        }),
      ),
    "Default site changed.",
  );
  revalidatePath("/admin/sites");
  return result;
}
