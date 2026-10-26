"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminMutation, unwrap, type ActionState } from "@/lib/admin-action";

const nameSchema = z.object({ name: z.string().trim().min(1).max(80) });

export async function createSite(_state: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = nameSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Enter a site name." };
  const result = await adminMutation(
    formData,
    { action: "site.create", input: parsed.data },
    async ({ supabase, claims }) => {
      const site = unwrap(
        await supabase
          .from("site")
          .insert({ org_id: claims.orgId, name: parsed.data.name })
          .select("id")
          .single(),
      );
      return { site_id: site?.id ?? null };
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
    { action: "site.rename", input: parsed.data },
    async ({ supabase }) => {
      unwrap(
        await supabase
          .from("site")
          .update({ name: parsed.data.name })
          .eq("id", parsed.data.site_id),
      );
      return parsed.data;
    },
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
    { action: "site.set_default", input: parsed.data },
    async ({ supabase }) => {
      unwrap(await supabase.rpc("admin_set_default_site", { p_site_id: parsed.data.site_id }));
      return parsed.data;
    },
    "Default site changed.",
  );
  revalidatePath("/admin/sites");
  return result;
}
