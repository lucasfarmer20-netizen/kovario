import type { KovarioClient } from "./clients";
import type { Json } from "./types";

/** Another request is running the same client_action_id right now; retry later. */
export class ActionInProgressError extends Error {
  constructor(readonly clientActionId: string) {
    super(`action ${clientActionId} is already in progress`);
    this.name = "ActionInProgressError";
  }
}

export type ActionMeta = {
  /** Stable action name, e.g. `intake.save`. A client_action_id is bound to one action. */
  action: string;
  /** Recorded in action_log for audit. Never include secrets. */
  input?: Json;
};

type BeginResult = { status: "new" } | { status: "pending" } | { status: "done"; result: Json };

function isBeginResult(value: unknown): value is BeginResult {
  if (typeof value !== "object" || value === null || !("status" in value)) return false;
  const status = (value as { status: unknown }).status;
  return status === "new" || status === "pending" || status === "done";
}

/**
 * Runs `fn` at most once per `clientActionId` (docs/01-ARCHITECTURE.md §7).
 * The first call claims the id in `action_log`, runs `fn` and stores its result; a replay
 * returns the stored result without running `fn`. If `fn` throws, the claim is released
 * so the client can retry with the same id.
 *
 * Multi-row money/release writes do not use this: they are single SQL functions that
 * call app.action_begin / app.action_complete inside their own transaction.
 */
export async function withAction<T extends Json>(
  client: KovarioClient,
  clientActionId: string,
  fn: () => Promise<T>,
  meta: ActionMeta,
): Promise<T> {
  const { data, error } = await client.rpc("action_begin", {
    p_client_action_id: clientActionId,
    p_action: meta.action,
    p_input: meta.input ?? null,
  });
  if (error) throw new Error(`action_begin failed: ${error.message}`);
  if (!isBeginResult(data)) throw new Error("action_begin returned an unexpected shape");

  if (data.status === "done") return data.result as T;
  if (data.status === "pending") throw new ActionInProgressError(clientActionId);

  let result: T;
  try {
    result = await fn();
  } catch (err) {
    await client.rpc("action_abort", { p_client_action_id: clientActionId });
    throw err;
  }

  const { error: completeError } = await client.rpc("action_complete", {
    p_client_action_id: clientActionId,
    p_result: result,
  });
  if (completeError) throw new Error(`action_complete failed: ${completeError.message}`);
  return result;
}
