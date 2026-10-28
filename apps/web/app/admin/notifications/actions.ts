"use server";

import { z } from "zod";
import { adminMutation, unwrap, type ActionState } from "@/lib/admin-action";

export async function notifyReady(_state: ActionState, form: FormData): Promise<ActionState> {
  const id = z.uuid().safeParse(form.get("intake_id"));
  if (!id.success) return { error: "Choose an intake." };
  return adminMutation(
    form,
    async ({ supabase }, actionId) =>
      unwrap(
        await supabase.rpc("customer_notify_ready", {
          p_client_action_id: actionId,
          p_intake_id: id.data,
        }),
      ),
    "Ready-for-pickup email queued.",
  );
}
