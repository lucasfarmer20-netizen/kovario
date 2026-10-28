"use server";

import { revalidatePath } from "next/cache";
import { adminMutation, unwrap, type ActionState } from "@/lib/admin-action";
import { parseStripeTerminalForm } from "@/lib/payment-terminals";

/** Adds a Stripe Terminal reader (no id) or edits one (docs/05-PAYMENTS.md §5). */
export async function saveStripeTerminal(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = parseStripeTerminalForm(Object.fromEntries(formData));
  if (!parsed.ok) return { error: parsed.error };
  const d = parsed.value;
  const result = await adminMutation(
    formData,
    async ({ supabase }, id) =>
      unwrap(
        await supabase.rpc("admin_save_stripe_terminal", {
          p_client_action_id: id,
          // null creates; the generated RPC type cannot express a nullable uuid arg.
          p_terminal_id: (d.terminal_id || null) as string,
          p_name: d.name,
          p_reader_id: d.reader_id,
          p_secret_ref: d.secret_ref,
          p_location_id: d.location_id || undefined,
          p_webhook_secret_ref: d.webhook_secret_ref || undefined,
          p_site_id: d.site_id || undefined,
          p_is_active: d.is_active === "on",
        }),
      ),
    d.terminal_id ? "Saved." : `Added ${d.name}.`,
  );
  revalidatePath("/admin/payment-terminals");
  return result;
}
