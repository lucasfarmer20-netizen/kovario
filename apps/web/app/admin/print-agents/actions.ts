"use server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { adminMutation, unwrap, type ActionState } from "@/lib/admin-action";
export async function createAgent(_state: ActionState, form: FormData): Promise<ActionState> {
  const value = z
    .object({ name: z.string().trim().min(1).max(80), site_id: z.union([z.uuid(), z.literal("")]) })
    .safeParse(Object.fromEntries(form));
  if (!value.success) return { error: "Enter a name and site." };
  const result = await adminMutation(
    form,
    async ({ supabase }, id) =>
      unwrap(
        await supabase.rpc("admin_create_print_agent", {
          p_client_action_id: id,
          p_name: value.data.name,
          p_site_id: value.data.site_id || undefined,
        }),
      ),
    "Agent added. Request a pairing code below.",
  );
  revalidatePath("/admin/print-agents");
  return result;
}
export async function pairAgent(_state: ActionState, form: FormData): Promise<ActionState> {
  const value = z.uuid().safeParse(form.get("agent_id"));
  if (!value.success) return { error: "Invalid agent." };
  // adminMutation deliberately discards the RPC result; keep the one-time code only
  // in the returned form state, never in action_log or a URL.
  let message = "Pairing request already handled. Request a fresh code.";
  const result = await adminMutation(
    form,
    async ({ supabase }, id) => {
      const data = unwrap(
        await supabase.rpc("admin_print_agent_pairing_code", {
          p_client_action_id: id,
          p_agent_id: value.data,
        }),
      );
      const code = data?.[0];
      if (code?.active)
        message = `Pairing code: ${code.code} - expires ${code.expires_at}. Run the agent with --pair.`;
      return {};
    },
    message,
  );
  return result.error ? result : { ok: message, nextActionId: randomUUID() };
}
