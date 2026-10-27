"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminMutation, unwrap, type ActionState } from "@/lib/admin-action";

const dim = z.union([z.literal(""), z.coerce.number().positive().max(999)]);
const weight = z.union([z.literal(""), z.coerce.number().min(0).max(999)]);

const sizeSchema = z.object({
  box_size_id: z.union([z.literal(""), z.uuid()]).optional(),
  name: z.string().trim().min(1).max(60),
  max_lb: z.coerce.number().positive().max(9999),
  fee: z.coerce.number().min(0).max(9999.99),
  length_in: dim,
  width_in: dim,
  height_in: dim,
  // Cold chain (docs/07 §4): added to the box's weight when shipping is quoted.
  packaging_lb: weight,
  dry_ice_lb: weight,
  // A checkbox: present = active.
  is_active: z.literal("on").optional(),
});

/** Adds a box size (no id) or edits one; the catalogue the counter plans boxes from. */
export async function saveBoxSize(_state: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = sizeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success)
    return {
      error:
        "Enter a name, a max lb above 0, a fee of 0 or more, positive inches and cold-chain lb of 0 or more.",
    };
  const d = parsed.data;
  const dims = Object.fromEntries(
    (["length_in", "width_in", "height_in", "packaging_lb", "dry_ice_lb"] as const)
      .filter((k) => d[k] !== "")
      .map((k) => [k, d[k] as number]),
  );
  const result = await adminMutation(
    formData,
    async ({ supabase }, id) =>
      unwrap(
        await supabase.rpc("admin_save_box_size", {
          p_client_action_id: id,
          // null creates; the generated RPC type cannot express a nullable uuid arg.
          p_box_size_id: (d.box_size_id || null) as string,
          p_name: d.name,
          p_max_lb: d.max_lb,
          p_fee: d.fee,
          p_dims: dims,
          p_is_active: d.is_active === "on",
        }),
      ),
    d.box_size_id ? "Saved." : `Added ${d.name}.`,
  );
  revalidatePath("/admin/box-sizes");
  return result;
}
