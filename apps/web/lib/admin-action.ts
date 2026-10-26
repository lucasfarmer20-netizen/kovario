import { ActionInProgressError, withAction, type ActionMeta, type Json } from "db";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { ForbiddenError, requireManager, type ManagerSession } from "./auth";

export type ActionState = { ok?: string; error?: string };

const actionIdSchema = z.uuid();

/** Throws a Supabase/PostgREST error so withAction releases its claim. */
export function unwrap<T>({ data, error }: { data: T; error: { message: string } | null }): T {
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Runs an owner/manager mutation once per `client_action_id` (withAction / action_log)
 * and maps failures to a form message. `meta.input` is stored in action_log: keep
 * secrets (PINs, codes) out of it.
 */
export async function adminMutation(
  formData: FormData,
  meta: ActionMeta,
  fn: (session: ManagerSession) => Promise<Json>,
  okMessage: string,
): Promise<ActionState> {
  const id = actionIdSchema.safeParse(formData.get("client_action_id"));
  if (!id.success) return { error: "Missing action id; reload the page." };
  try {
    const session = await requireManager();
    await withAction(session.supabase, id.data, () => fn(session), meta);
    return { ok: okMessage };
  } catch (err) {
    unstable_rethrow(err); // let the /login redirect through
    if (err instanceof ForbiddenError) return { error: "Managers only." };
    if (err instanceof ActionInProgressError)
      return { error: "Still saving — try again in a moment." };
    return { error: err instanceof Error ? err.message : "Something went wrong." };
  }
}
