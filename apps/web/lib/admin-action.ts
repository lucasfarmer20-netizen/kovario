import { withAction, type Json } from "db";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { ForbiddenError, requireManager, type ManagerSession } from "./auth";

export type ActionState = { ok?: string; error?: string };

const actionIdSchema = z.uuid();

/** Throws a Supabase/PostgREST error so it surfaces as a form message. */
export function unwrap<T>({ data, error }: { data: T; error: { message: string } | null }): T {
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Runs an owner/manager mutation at most once per form `client_action_id` (withAction).
 * `fn` must pass the id to an admin_* SQL function — which writes and records the action
 * in one transaction — and return that function's result.
 */
export async function adminMutation(
  formData: FormData,
  fn: (session: ManagerSession, clientActionId: string) => Promise<Json>,
  okMessage: string,
): Promise<ActionState> {
  const id = actionIdSchema.safeParse(formData.get("client_action_id"));
  if (!id.success) return { error: "Missing action id; reload the page." };
  try {
    const session = await requireManager();
    await withAction(session.supabase, id.data, (clientActionId) => fn(session, clientActionId));
    return { ok: okMessage };
  } catch (err) {
    unstable_rethrow(err); // let the /login redirect through
    if (err instanceof ForbiddenError) return { error: "Managers only." };
    return { error: err instanceof Error ? err.message : "Something went wrong." };
  }
}
