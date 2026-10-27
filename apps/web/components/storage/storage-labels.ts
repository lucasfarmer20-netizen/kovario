import { storageBoxLabel } from "labels/zpl";

// Storage box labels are rendered on the station with the WP-08 template (its QR text comes
// from packages/rules qr.ts) and queued as ZPL by queue_storage_labels; the print agent sends
// the payload to the printer as-is.

export type LabelData = {
  storage_intake_id: string;
  storage_number: string;
  customer: string;
  date: string;
  boxes: { box_id: string; box_no: number }[];
};

export type RenderedLabel = { box_id: string; zpl: string };

/** One ZPL label per box (all boxes, or only `boxIds`). */
export function renderStorageLabels(data: LabelData, boxIds?: string[]): RenderedLabel[] {
  return data.boxes
    .filter((b) => !boxIds || boxIds.includes(b.box_id))
    .map((b) => ({
      box_id: b.box_id,
      zpl: storageBoxLabel({
        storageNumber: data.storage_number,
        boxNo: b.box_no,
        customer: data.customer,
        date: data.date,
      }),
    }));
}
