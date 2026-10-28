"use client";
import { withAction, type FilletryClient, type Json } from "db";
import type { CompletePayload, Wizard } from "./boxing-state";

// Station-side calls for boxing / will-call. Every mutation is one SQL function keyed by a
// client_action_id (withAction): release_party, release_by_tag, restore_vessel. Each locks
// sessions → vessels → intakes and re-reads under the lock, so a retry or a concurrent
// Complete replays or no-ops instead of releasing twice (D0 / I16).

type DbError = { message: string; hint?: string | null };

/** A failed RPC; `hint` carries the SQL `HINT` (machine-readable codes such as I8's). */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly hint: string | null,
  ) {
    super(message);
  }
}

function unwrap<T>({ data, error }: { data: T; error: DbError | null }): T {
  if (error) throw new RpcError(error.message, error.hint ?? null);
  return data;
}

async function act<T>(
  client: FilletryClient,
  clientActionId: string,
  fn: (id: string) => PromiseLike<{ data: Json; error: DbError | null }>,
): Promise<T> {
  const result = await withAction(client, clientActionId, async (id) => unwrap(await fn(id)));
  return result as unknown as T;
}

export async function loadWizard(client: FilletryClient, sessionId: string): Promise<Wizard> {
  return unwrap(
    await client.rpc("boxing_wizard", { p_session_id: sessionId }),
  ) as unknown as Wizard;
}

/** Priced parties with boxes still to hand over (the boxing queue), oldest first. */
export async function boxingQueue(client: FilletryClient) {
  const rows = unwrap(
    await client
      .from("allocation_session_list")
      .select(
        "session_id, number, party_name, fulfillment_status, planned_count, box_count, created_at",
      )
      .eq("state", "priced")
      .in("fulfillment_status", ["pending", "partial"])
      .order("created_at")
      .limit(200),
  );
  return (rows ?? []).map((r) => ({
    session_id: r.session_id!,
    number: r.number!,
    party_name: r.party_name,
    fulfillment_status: r.fulfillment_status ?? "pending",
    planned_count: r.planned_count ?? 0,
    box_count: r.box_count ?? 0,
  }));
}

export type ReleaseStale = { kind: "box" | "vessel"; id: string; label: string; state: string };

export type ReleaseReply = {
  ok: boolean;
  noop: boolean;
  message?: string;
  session_number: string;
  session_state: string;
  finalized: { box_id: string; number: string; method: string; state: string }[];
  moved: { vessel_id: string; label: string; action: "full_pull" | "split"; weight_left: number }[];
  stale: ReleaseStale[];
  closed_intakes: string[];
  shipping: { box_number: string; notice: string }[];
  i8_override?: boolean;
};

export function completeRelease(
  client: FilletryClient,
  clientActionId: string,
  sessionId: string,
  payload: CompletePayload,
  paymentRef: string,
  operatorSession: string | null,
  /** I8 manager override: reason + elevation token (null when a manager is signed in). */
  override?: { reason: string; token: string | null },
) {
  return act<ReleaseReply>(client, clientActionId, (id) =>
    client.rpc("release_party", {
      p_client_action_id: id,
      p_session_id: sessionId,
      p_box_ticks: payload.box_ticks,
      p_vessel_ticks: payload.vessel_ticks as unknown as Json,
      p_payment_ref: paymentRef.trim() || undefined,
      p_operator_session: operatorSession ?? undefined,
      p_i8_override_reason: override?.reason,
      p_elevation_token: override?.token ?? undefined,
    }),
  );
}

export type TagReleaseReply = {
  noop: boolean;
  message?: string;
  label?: string;
  action?: "full_pull" | "split";
  weight_left?: number;
  session_number?: string | null;
  closed_intakes?: string[];
  warnings: string[];
};

export function releaseByTag(
  client: FilletryClient,
  tag: string,
  lbsLeft: number | null,
  reason: string,
  elevationToken: string | null,
) {
  return act<TagReleaseReply>(client, crypto.randomUUID(), (id) =>
    client.rpc("release_by_tag", {
      p_client_action_id: id,
      p_tag: tag,
      p_lbs_left: lbsLeft ?? 0,
      p_reason: reason,
      p_elevation_token: elevationToken ?? undefined,
    }),
  );
}

export type RestoreReply = {
  restored: boolean;
  message?: string;
  weight_lb?: number;
  tag_code?: string | null;
  location_code?: string | null;
  intake_reopened?: boolean;
  warnings: string[];
};

export function restoreVessel(
  client: FilletryClient,
  vesselId: string,
  reason: string,
  elevationToken: string | null,
) {
  return act<RestoreReply>(client, crypto.randomUUID(), (id) =>
    client.rpc("restore_vessel", {
      p_client_action_id: id,
      p_vessel_id: vesselId,
      p_reason: reason,
      p_elevation_token: elevationToken ?? undefined,
    }),
  );
}

export type EmptiedVessel = {
  id: string;
  intake_number: string;
  tag_code: string | null;
  weight_lb: number | null;
  emptied_at: string | null;
};

/** The party's emptied baskets (restore candidates), latest first. */
export async function emptiedVessels(
  client: FilletryClient,
  intakeIds: string[],
): Promise<EmptiedVessel[]> {
  if (intakeIds.length === 0) return [];
  const rows = unwrap(
    await client
      .from("vessel")
      .select("id, emptied_at, release_snapshot, is_exchange, intake:intake_id (number)")
      .in("intake_id", intakeIds)
      .eq("lifecycle_state", "emptied")
      .order("emptied_at", { ascending: false })
      .limit(50),
  );
  return (rows ?? []).map((r) => {
    const snap = (r.release_snapshot ?? {}) as { tag_code?: string | null; weight_lb?: number };
    return {
      id: r.id,
      intake_number: r.intake?.number ?? "",
      tag_code: snap.tag_code ?? null,
      weight_lb: snap.weight_lb ?? null,
      emptied_at: r.emptied_at,
    };
  });
}
