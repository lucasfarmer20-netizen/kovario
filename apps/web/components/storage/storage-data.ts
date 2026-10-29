"use client";
import { withAction, type Database, type FilletryClient, type Json } from "db";
import { renderStorageLabels, type LabelData } from "./storage-labels";
import type { ConfirmPayload } from "./storage-state";
import type { ParseResult } from "rules";
import { withEntryMethod, type EntryMethod } from "@/src/components/station/entry-method";

// Station-side calls for cold storage. Every mutation is one SQL function keyed by a
// client_action_id (withAction), so a retried request replays instead of writing twice.
// Day counts come only from the storage_box_days view / storage_pickup_quote (S4).

function unwrap<T>({ data, error }: { data: T; error: { message: string } | null }): T {
  if (error) throw new Error(error.message);
  return data;
}

async function act<T>(
  client: FilletryClient,
  clientActionId: string,
  fn: (id: string) => PromiseLike<{ data: Json; error: { message: string } | null }>,
): Promise<T> {
  const result = await withAction(client, clientActionId, async (id) => unwrap(await fn(id)));
  return result as unknown as T;
}

export type StorageState = Database["public"]["Enums"]["storage_intake_state"];

export async function listLocations(client: FilletryClient) {
  const { data, error } = await client
    .from("location")
    .select("id, code")
    .eq("is_active", true)
    .order("sort_key")
    .limit(500);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export type ConfirmResult = {
  storage_intake_id: string;
  number: string;
  labels: LabelData;
};

export function confirmStorageIntake(
  client: FilletryClient,
  clientActionId: string,
  payload: ConfirmPayload,
): Promise<ConfirmResult> {
  return act(client, clientActionId, (id) =>
    client.rpc("confirm_storage_intake", {
      p_client_action_id: id,
      p_payload: payload as unknown as Json,
    }),
  );
}

export async function loadLabelData(client: FilletryClient, storageIntakeId: string) {
  const data = unwrap(
    await client.rpc("storage_label_data", { p_storage_intake_id: storageIntakeId }),
  );
  return data as unknown as LabelData;
}

export type LabelsQueued = { label_jobs_queued: number; printer_missing: boolean };

/** Renders the box labels (all, or `boxIds`) and queues them as ZPL print jobs. */
export function printLabels(
  client: FilletryClient,
  data: LabelData,
  boxIds?: string[],
): Promise<LabelsQueued> {
  const labels = renderStorageLabels(data, boxIds);
  return act(client, crypto.randomUUID(), (id) =>
    client.rpc("queue_storage_labels", {
      p_client_action_id: id,
      p_storage_intake_id: data.storage_intake_id,
      p_labels: labels as unknown as Json,
    }),
  );
}

export type Quote = {
  rate: number;
  box_days: number;
  amount: number;
  boxes: { box_id: string; box_no: number; label: string; days: number; amount: number }[];
};

export async function quotePickup(
  client: FilletryClient,
  storageIntakeId: string,
  boxIds: string[],
): Promise<Quote> {
  const data = unwrap(
    await client.rpc("storage_pickup_quote", {
      p_storage_intake_id: storageIntakeId,
      p_box_ids: boxIds,
    }),
  );
  return data as unknown as Quote;
}

export type BatchResult = Quote & { batch_id: string; number: string; superseded: string[] };

export function createPickupBatch(
  client: FilletryClient,
  clientActionId: string,
  storageIntakeId: string,
  boxIds: string[],
): Promise<BatchResult> {
  return act(client, clientActionId, (id) =>
    client.rpc("create_pickup_batch", {
      p_client_action_id: id,
      p_storage_intake_id: storageIntakeId,
      p_box_ids: boxIds,
    }),
  );
}

export function cancelPickupBatch(client: FilletryClient, batchId: string) {
  return act(client, crypto.randomUUID(), (id) =>
    client.rpc("cancel_pickup_batch", { p_client_action_id: id, p_batch_id: batchId }),
  );
}

/** Manager Force Release ('manual') or COMP ('comp'); reason required. */
export function forceRelease(
  client: FilletryClient,
  batchId: string,
  mode: "manual" | "comp",
  reason: string,
  elevationToken: string,
) {
  return act<{ status: string; payment_ref: string }>(client, crypto.randomUUID(), (id) =>
    client.rpc("force_release_pickup_batch", {
      p_client_action_id: id,
      p_batch_id: batchId,
      p_mode: mode,
      p_reason: reason,
      p_elevation_token: elevationToken,
    }),
  );
}

export type PickupReceipt = {
  number: string;
  storage_number: string;
  customer: string;
  date: string;
  rate: number;
  lines: { box_id: string; label: string; days: number; rate: number; amount: number }[];
  total: number;
  payment_ref: string | null;
};

export async function pickupReceipt(client: FilletryClient, batchId: string) {
  const data = unwrap(await client.rpc("storage_pickup_receipt", { p_batch_id: batchId }));
  return data as unknown as PickupReceipt;
}

export async function loadStorageIntake(client: FilletryClient, id: string) {
  const [intake, boxes, batches] = await Promise.all([
    client
      .from("storage_intake")
      .select(
        "id, number, state, intake_at, notes, box_count, active_box_count, paid_at, payment_ref, customer(name, phone), location(code)",
      )
      .eq("id", id)
      .maybeSingle(),
    client
      .from("storage_box_days")
      .select(
        "storage_box_id, box_no, label, state, released_at, days_stored, weight_lb, description, batch_id",
      )
      .eq("storage_intake_id", id)
      .order("box_no"),
    client
      .from("storage_pickup_batch")
      .select(
        "id, number, state, box_ids, rate_per_box_day, amount, payment_ref, paid_at, released_at, release_failed, notes, created_at",
      )
      .eq("storage_intake_id", id)
      .order("created_at", { ascending: false }),
  ]);
  return {
    intake: unwrap(intake),
    boxes: unwrap(boxes) ?? [],
    batches: unwrap(batches) ?? [],
  };
}

export type LoadedStorageIntake = Awaited<ReturnType<typeof loadStorageIntake>>;

/** Queue rows with pending-batch counts and the oldest stored box's days (from the view). */
export async function listStorageIntakes(client: FilletryClient, state: StorageState | null) {
  let q = client
    .from("storage_intake")
    .select(
      "id, number, state, intake_at, box_count, active_box_count, customer(name), location(code), storage_pickup_batch(state)",
    )
    .order("intake_at", { ascending: true })
    .limit(300);
  q = state ? q.eq("state", state) : q.in("state", ["stored", "partial"]);
  const rows = unwrap(await q) ?? [];
  const days = new Map<string, number>();
  if (rows.length > 0) {
    const boxes = unwrap(
      await client
        .from("storage_box_days")
        .select("storage_intake_id, days_stored")
        .in(
          "storage_intake_id",
          rows.map((r) => r.id),
        ),
    );
    for (const b of boxes ?? []) {
      if (!b.storage_intake_id || b.days_stored === null) continue;
      days.set(b.storage_intake_id, Math.max(days.get(b.storage_intake_id) ?? 0, b.days_stored));
    }
  }
  return rows.map((r) => ({
    ...r,
    days: days.get(r.id) ?? null,
    pending_batches: r.storage_pickup_batch.filter((b) => b.state === "pending").length,
  }));
}

export type BoxScanReply = { ok: boolean; reason: string; box_id: string | null };

/**
 * A box code typed (or scanned) into the pickup wizard, checked against the storage master
 * and logged in scan_log (issue #84). `parsed` is what rules/qr.ts read from the text; the
 * raw text is logged as entered. Typed codes carry the entry-method header.
 */
export async function scanStorageBox(
  client: FilletryClient,
  storageIntakeId: string,
  raw: string,
  parsed: ParseResult,
  method: EntryMethod,
): Promise<BoxScanReply> {
  const box = parsed.ok && parsed.value.kind === "SBOX" ? parsed.value : null;
  return act<BoxScanReply>(client, crypto.randomUUID(), (id) =>
    withEntryMethod(
      client.rpc("storage_box_scan", {
        p_client_action_id: id,
        p_raw: raw,
        p_storage_intake_id: storageIntakeId,
        p_storage_number: box?.storageNumber,
        p_box_no: box?.boxNo,
      }),
      method,
    ),
  );
}
