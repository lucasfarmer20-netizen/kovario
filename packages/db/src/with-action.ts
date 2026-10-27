import type { FilletryClient } from "./clients";
import type { Json } from "./types";

/**
 * Runs a mutation at most once per `clientActionId` (docs/01-ARCHITECTURE.md §7,
 * AGENTS.md hard rule 3).
 *
 * `fn` receives the id and must hand it to a single SQL function that claims it
 * (`app.action_begin`), performs the domain write and stores the result
 * (`app.action_complete`) in ONE transaction — e.g.
 * `client.rpc("admin_create_site", { p_client_action_id: id, p_name })`. The write and its
 * action_log result therefore commit together: a lost response or crashed client retries
 * the same id and gets the stored result, never a second write, and a concurrent duplicate
 * waits on the action_log unique index and replays.
 *
 * A completed id is answered from `action_log` without calling `fn`, so side effects
 * outside the database (e.g. the invite email sent by `member-invite`) are skipped on
 * replay. Side effects before the SQL call must themselves be safe to repeat, because a
 * retry after a lost response that never reached the database runs `fn` again.
 */
export async function withAction<T extends Json>(
  client: FilletryClient,
  clientActionId: string,
  fn: (clientActionId: string) => Promise<T>,
): Promise<T> {
  const { data, error } = await client
    .from("action_log")
    .select("result, completed_at")
    .eq("client_action_id", clientActionId)
    .maybeSingle();
  if (error) throw new Error(`action_log lookup failed: ${error.message}`, { cause: error });
  if (data?.completed_at) return data.result as T;
  return fn(clientActionId);
}
