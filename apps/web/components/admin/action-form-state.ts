import type { ActionState } from "@/lib/admin-action";

/** Preserve the current ID on errors, including errors after a previous success. */
export async function submitAdminForm(
  action: (state: ActionState, form: FormData) => Promise<ActionState>,
  previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await action(previous, form);
  return { ...result, nextActionId: result.nextActionId ?? previous.nextActionId };
}
