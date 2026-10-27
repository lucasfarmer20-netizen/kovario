import { describe, expect, it } from "vitest";
import {
  anglerLb,
  emptyAngler,
  emptyBox,
  newDraft,
  parseAmount,
  previewSettlements,
  savePayload,
  type SessionDraft,
} from "./allocate-state";

const intake = { id: "i-1", number: "INT-0001", state: "stored", customer: "Pat" };

function draft(): SessionDraft {
  const d: SessionDraft = newDraft([intake], { id: "c-1", name: "Pat" });
  const ann = {
    ...emptyAngler("Ann"),
    species: [{ key: "s1", species_code: "salmon_silvers", method_code: "fillets", lb: "10" }],
    boxes: [{ ...emptyBox("size-m"), method: "ship" as const, weight: "45" }],
  };
  const bo = {
    ...emptyAngler("Bo"),
    species: [{ key: "s2", species_code: "whitefish_halibut", method_code: "portions", lb: "20" }],
  };
  return { ...d, anglers: [ann, bo] };
}

describe("WP14 allocation draft → save_allocation_session payload", () => {
  it("builds the payload: intakes, split, anglers with species lb and box plans (no vessel field)", () => {
    const built = savePayload(draft());
    expect("payload" in built).toBe(true);
    if (!("payload" in built)) return;
    expect(built.payload).toMatchObject({
      session_id: null,
      party_customer_id: "c-1",
      split_method: "weight",
      intake_ids: ["i-1"],
      settlements: [
        {
          angler_name: "Ann",
          species: [{ species_code: "salmon_silvers", method_code: "fillets", lb: 10 }],
          boxes: [{ method: "ship", box_size_id: "size-m", weight_lb: 45, heavy_allowed: false }],
        },
        { angler_name: "Bo", boxes: [] },
      ],
    });
    // Founding rule: box plans carry no vessel link.
    expect(JSON.stringify(built.payload)).not.toMatch(/vessel/);
  });

  it("heavy check: a box over 70 lb needs Heavy OK", () => {
    const d = draft();
    d.anglers[0]!.boxes[0]!.weight = "75";
    expect(savePayload(d)).toEqual({
      errors: ["Ann box 1: over 70 lb — tick Heavy OK to confirm."],
    });
    d.anglers[0]!.boxes[0]!.heavy_allowed = true;
    expect("payload" in savePayload(d)).toBe(true);
  });

  it("names, sizes, weights, duplicates and an empty session are refused", () => {
    const d = draft();
    d.anglers[1]!.angler_name = " ";
    d.anglers[0]!.boxes[0]!.box_size_id = "";
    d.anglers[0]!.species.push({ ...d.anglers[0]!.species[0]!, key: "dup" });
    d.anglers[0]!.species[0]!.lb = "1.234";
    const result = savePayload({ ...d, intakes: [] });
    expect(result).toEqual({
      errors: [
        "Add at least one intake to the session.",
        "Ann: lb must be a number (up to 2 decimals).",
        "Ann: a species and method is listed twice.",
        "Ann box 1: pick a size.",
        "Angler 2: enter the angler's name.",
      ],
    });
  });

  it("blank species rows are dropped, not sent", () => {
    const d = draft();
    d.anglers[1]!.species.push({ key: "blank", species_code: "", method_code: "", lb: "" });
    const built = savePayload(d);
    expect("payload" in built && built.payload.settlements[1]!.species).toHaveLength(1);
  });
});

describe("WP14 live price preview (packages/rules priceSettlements)", () => {
  it("weight split of the pooled charges, plus box fees", () => {
    const preview = previewSettlements(draft(), 100.01, { "size-m": 12.5 });
    expect(preview).toEqual({
      settlements: [
        {
          weightTotalLb: 10,
          processingShare: 33.34,
          boxFeeTotal: 12.5,
          freightTotal: 0,
          amountTotal: 45.84,
        },
        {
          weightTotalLb: 20,
          processingShare: 66.67,
          boxFeeTotal: 0,
          freightTotal: 0,
          amountTotal: 66.67,
        },
      ],
    });
  });

  it("even split ignores lb; a weight split with no lb explains itself", () => {
    const d = { ...draft(), splitMethod: "even" as const };
    const even = previewSettlements(d, 100.01, {});
    expect("settlements" in even && even.settlements.map((s) => s.processingShare)).toEqual([
      50.01, 50,
    ]);
    const none = draft();
    none.anglers.forEach((a) => a.species.forEach((s) => (s.lb = "0")));
    expect(previewSettlements(none, 10, {})).toEqual({
      reason: expect.stringMatching(/take-home lb/),
    });
  });

  it("amounts parse to 2 dp; angler lb sums its species", () => {
    expect(parseAmount("12.5")).toBe(12.5);
    expect(parseAmount(".75")).toBe(0.75);
    expect(parseAmount("1.234")).toBeNull();
    expect(parseAmount("-1")).toBeNull();
    const a = draft().anglers[0]!;
    a.species.push({ key: "x", species_code: "k", method_code: "m", lb: "2.25" });
    expect(anglerLb(a)).toBe(12.25);
  });
});
