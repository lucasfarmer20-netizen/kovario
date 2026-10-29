// Pure helpers for the cold storage station (docs/06-STATIONS-UX.md Storage intake). Day
// counts and money are never computed here: they come from app.storage_box_days and
// app.storage_snapshot (S4) through the storage_box_days view and storage_pickup_quote.

import type { ParseResult } from "rules";

export type BoxRow = { key: string; weight: string; description: string };

export type ConfirmPayload = {
  customer_id: string;
  location_id: string | null;
  notes: string | null;
  boxes: { weight_lb: number | null; description: string | null }[];
};

export const STORAGE_STATE_LABELS: Record<string, string> = {
  draft: "Draft",
  stored: "Stored",
  partial: "Partly picked up",
  released: "Picked up",
  cancelled: "Cancelled",
};

export const BATCH_STATE_LABELS: Record<string, string> = {
  pending: "Awaiting payment",
  released: "Released",
  void: "Void",
};

export function emptyBox(): BoxRow {
  return { key: crypto.randomUUID(), weight: "", description: "" };
}

/** Box rows → the confirm_storage_intake payload, or the problems to show. */
export function confirmPayload(input: {
  customerId: string | null;
  locationId: string;
  notes: string;
  rows: BoxRow[];
}): { payload: ConfirmPayload } | { errors: string[] } {
  const errors: string[] = [];
  if (!input.customerId) errors.push("Pick or create the customer.");
  if (input.rows.length === 0) errors.push("Add at least one box.");
  const boxes = input.rows.map((row, i) => {
    const raw = row.weight.trim();
    const weight = raw === "" ? null : Number(raw);
    if (weight !== null && (!Number.isFinite(weight) || weight < 0)) {
      errors.push(`Box ${i + 1}: weight must be a number of lb (0 or more).`);
    }
    return { weight_lb: weight, description: row.description.trim() || null };
  });
  if (errors.length > 0 || !input.customerId) return { errors };
  return {
    payload: {
      customer_id: input.customerId,
      location_id: input.locationId || null,
      notes: input.notes.trim() || null,
      boxes,
    },
  };
}

/** Toggles a box in the pickup selection; only stored boxes can be picked. */
export function toggleBox(selected: string[], boxId: string, stored: boolean): string[] {
  if (selected.includes(boxId)) return selected.filter((id) => id !== boxId);
  return stored ? [...selected, boxId] : selected;
}

/** "2 of 5 boxes left" — the queue's partial/released rollup line. */
export function boxRollup(active: number, total: number): string {
  if (total === 0) return "No boxes";
  if (active === 0) return `All ${total} picked up`;
  if (active === total) return `${total} box${total === 1 ? "" : "es"} stored`;
  return `${active} of ${total} boxes left`;
}

/** Whole days in storage for the queue's age badge ("12 days"). */
export function daysLabel(days: number): string {
  return `${days} day${days === 1 ? "" : "s"}`;
}

export type PickableBox = {
  storage_box_id: string | null;
  box_no: number | null;
  state: string | null;
};

/**
 * A scanned or typed storage-box code (`STG-0001-2`, issue #84) → that box added to the
 * pickup selection. The code is matched against this intake's own boxes: a box of another
 * intake, an unknown box or one already picked up is refused, never guessed.
 */
export function pickBoxByCode(
  intakeNumber: string,
  boxes: PickableBox[],
  selected: string[],
  parsed: ParseResult,
): { ok: boolean; selected: string[]; message: string } {
  const refuse = (message: string) => ({ ok: false, selected, message });
  if (!parsed.ok || parsed.value.kind !== "SBOX")
    return refuse("Not a storage box code. Type it as printed, e.g. STG-0001-2.");
  const { storageNumber, boxNo } = parsed.value;
  const code = `${storageNumber}-${boxNo}`;
  if (storageNumber !== intakeNumber) return refuse(`${code} is not on ${intakeNumber}.`);
  const box = boxes.find((b) => b.box_no === boxNo);
  if (!box?.storage_box_id) return refuse(`No box ${boxNo} on ${intakeNumber}.`);
  if (box.state !== "stored") return refuse(`Box ${boxNo} is already picked up.`);
  if (selected.includes(box.storage_box_id))
    return { ok: true, selected, message: `Box ${boxNo} is already selected.` };
  return {
    ok: true,
    selected: [...selected, box.storage_box_id],
    message: `Box ${boxNo} selected for pickup.`,
  };
}
