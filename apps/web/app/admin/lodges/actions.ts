"use server";

import { revalidatePath } from "next/cache";
import { normalizePhone } from "rules";
import { z } from "zod";
import { adminMutation, unwrap, type ActionState } from "@/lib/admin-action";

const lodgeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  // Per-lb cap for the lodge's guests; empty = no cap.
  pricing_cap: z.union([z.literal(""), z.coerce.number().min(0).max(9999.99)]),
  contact_name: z.string().trim().max(80),
  contact_phone: z.string().trim().max(30),
  contact_email: z.union([z.email(), z.literal("")]),
});

type LodgeFields = z.infer<typeof lodgeSchema>;

/** The RPC arguments for a lodge form, or an error message. */
function lodgeArgs(
  data: LodgeFields,
):
  { error: string } | { p_name: string; p_pricing_cap: number; p_contact: Record<string, string> } {
  const phone = data.contact_phone ? normalizePhone(data.contact_phone) : "";
  if (phone === null) return { error: "Enter a full contact phone, e.g. (907) 555-1234." };
  const contact = Object.fromEntries(
    Object.entries({ name: data.contact_name, phone, email: data.contact_email }).filter(
      ([, v]) => v !== "",
    ),
  );
  return {
    p_name: data.name,
    // null clears the cap; the generated RPC type cannot express a nullable numeric arg.
    p_pricing_cap: (data.pricing_cap === "" ? null : data.pricing_cap) as number,
    p_contact: contact,
  };
}

export async function createLodge(_state: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = lodgeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Enter a name and a cap of 0 or more (or leave it empty)." };
  const args = lodgeArgs(parsed.data);
  if ("error" in args) return args;
  const result = await adminMutation(
    formData,
    async ({ supabase }, id) =>
      unwrap(await supabase.rpc("admin_create_lodge", { p_client_action_id: id, ...args })),
    `Added ${parsed.data.name}.`,
  );
  revalidatePath("/admin/lodges");
  return result;
}

const updateSchema = lodgeSchema.extend({ lodge_id: z.uuid() });

export async function updateLodge(_state: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = updateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Enter a name and a cap of 0 or more (or leave it empty)." };
  const args = lodgeArgs(parsed.data);
  if ("error" in args) return args;
  const result = await adminMutation(
    formData,
    async ({ supabase }, id) =>
      unwrap(
        await supabase.rpc("admin_update_lodge", {
          p_client_action_id: id,
          p_lodge_id: parsed.data.lodge_id,
          ...args,
        }),
      ),
    "Saved.",
  );
  revalidatePath("/admin/lodges");
  return result;
}
