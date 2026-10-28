"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminMutation, unwrap, type ActionState } from "@/lib/admin-action";

const productSchema = z.object({
  retail_product_id: z.union([z.literal(""), z.uuid()]).optional(),
  name: z.string().trim().min(1).max(80),
  sku: z.string().trim().max(40),
  unit_price: z.coerce.number().min(0).max(99999.99),
  // A checkbox: present = active.
  is_active: z.literal("on").optional(),
});

/** Adds a retail product (no id) or edits one: the register's minimal catalogue. */
export async function saveRetailProduct(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = productSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Enter a name and a price of 0 or more." };
  const d = parsed.data;
  const result = await adminMutation(
    formData,
    async ({ supabase }, id) =>
      unwrap(
        await supabase.rpc("admin_save_retail_product", {
          p_client_action_id: id,
          // null creates; the generated RPC type cannot express a nullable uuid arg.
          p_retail_product_id: (d.retail_product_id || null) as string,
          p_name: d.name,
          p_unit_price: d.unit_price,
          p_sku: d.sku || undefined,
          p_is_active: d.is_active === "on",
        }),
      ),
    d.retail_product_id ? "Saved." : `Added ${d.name}.`,
  );
  revalidatePath("/admin/retail-products");
  return result;
}
