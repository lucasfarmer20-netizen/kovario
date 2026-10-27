"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminMutation, unwrap, type ActionState } from "@/lib/admin-action";
import { settingsFromForm } from "@/lib/org-settings";

const orgSchema = z.object({
  name: z.string().trim().min(1).max(120),
  timezone: z.string().min(1).max(64),
});

export async function saveOrgSettings(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const org = orgSchema.safeParse(Object.fromEntries(formData));
  if (!org.success) return { error: "Enter the business name and pick a time zone." };
  const built = settingsFromForm(formData);
  if ("error" in built) return built;
  const result = await adminMutation(
    formData,
    async ({ supabase }, id) =>
      unwrap(
        await supabase.rpc("admin_update_org", {
          p_client_action_id: id,
          p_name: org.data.name,
          p_timezone: org.data.timezone,
          p_settings: built.settings,
        }),
      ),
    "Settings saved.",
  );
  revalidatePath("/admin", "layout");
  return result;
}
