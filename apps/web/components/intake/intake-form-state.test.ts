import { describe, expect, it } from "vitest";
import {
  coolerBadge,
  emptyRow,
  intakeTimeline,
  lineToRow,
  methodOptions,
  conditionOptions,
  parseToteCount,
  rowsToLines,
  speciesOptions,
  updateRow,
  type OrgReference,
} from "./intake-form-state";

const row = (code: string, name: string, sort = 0, is_active = true) => ({
  code,
  name,
  sort,
  is_active,
});
const REF: OrgReference = {
  species: [
    row("whitefish_halibut", "Halibut", 20),
    row("salmon_silvers", "Silvers", 10),
    row("other_octopus", "Octopus", 30, false),
  ],
  conditions: [row("whole", "Whole"), row("filleted_ribs", "Ribs in"), row("vsr", "VSR", 0, false)],
  methods: [row("fresh", "Fresh"), row("smoking", "Smoking"), row("portions", "Portions")],
};

describe("dropdowns follow the matrices and the org's active rows", () => {
  it("species: active only, by sort", () => {
    expect(speciesOptions(REF).map((o) => o.code)).toEqual(["salmon_silvers", "whitefish_halibut"]);
  });

  it("conditions and methods: matrix-allowed and active, with org names", () => {
    expect(conditionOptions(REF, "whitefish_halibut")).toEqual([
      { code: "whole", name: "Whole" },
      { code: "filleted_ribs", name: "Ribs in" },
    ]);
    expect(methodOptions(REF, "salmon_silvers", "whole").map((o) => o.code)).toEqual([
      "fresh",
      "smoking",
    ]);
    expect(methodOptions(REF, "whitefish_halibut", "filleted_ribs")).toEqual([
      { code: "portions", name: "Portions" },
    ]);
  });
});

describe("updateRow", () => {
  it("a species change clears selections the matrix no longer allows", () => {
    const salmon = updateRow(REF, emptyRow(), {
      species: "salmon_silvers",
      condition: "whole",
      method: "fresh",
      filletsPct: "60",
    });
    expect([salmon.method, salmon.filletsPct]).toEqual(["fresh", "60"]);
    const halibut = updateRow(REF, salmon, { species: "whitefish_halibut" });
    expect(halibut.condition).toBe("whole");
    expect([halibut.method, halibut.filletsPct]).toEqual(["portions", ""]); // single option picked
  });

  it("skin-off is cleared for species that do not allow it", () => {
    const r = updateRow(REF, { ...emptyRow(), species: "whitefish_halibut", skinOff: true }, {});
    expect(r.skinOff).toBe(true);
    expect(updateRow(REF, r, { species: "salmon_silvers" }).skinOff).toBe(false);
  });
});

describe("rowsToLines", () => {
  const fresh = { ...emptyRow(), species: "salmon_silvers", condition: "whole", method: "fresh" };

  it("parses complete rows and skips blank ones", () => {
    const { lines, errors } = rowsToLines([
      { ...fresh, lb: " 50.355 ", filletsPct: "60" },
      emptyRow(),
    ]);
    expect(errors).toEqual([]);
    expect(lines).toEqual([
      {
        species: "salmon_silvers",
        condition: "whole",
        method: "fresh",
        lb: 50.36,
        filletsPct: 60,
        skinOff: false,
        notes: "",
      },
    ]);
  });

  it("reports what is missing per line", () => {
    expect(rowsToLines([{ ...fresh, lb: "50" }]).errors).toEqual([
      "Line 1: enter fillets % (0–100).",
    ]);
    expect(rowsToLines([{ ...fresh, lb: "0", filletsPct: "1" }]).errors).toEqual([
      "Line 1: enter the weight in lb.",
    ]);
    expect(rowsToLines([{ ...emptyRow(), species: "salmon_silvers" }]).errors).toEqual([
      "Line 1: pick a condition.",
    ]);
    expect(rowsToLines([emptyRow()]).errors).toEqual(["Add at least one species line."]);
  });

  it("round-trips a saved line for editing", () => {
    const r = lineToRow({
      species_code: "salmon_silvers",
      condition_code: "whole",
      method_code: "fresh",
      lb: 50,
      fillets_pct: 60,
      skin_off: false,
      notes: null,
    });
    expect(rowsToLines([r]).lines[0]).toMatchObject({ lb: 50, filletsPct: 60, notes: "" });
  });
});

describe("detail helpers", () => {
  it("tote count is a whole number from 1", () => {
    expect([
      parseToteCount("3"),
      parseToteCount("0"),
      parseToteCount("1.5"),
      parseToteCount(""),
    ]).toEqual([3, null, null, null]);
  });

  it("timeline lists set stamps in lifecycle order", () => {
    const none = {
      hold_until: null,
      pulled_at: null,
      rollstock_at: null,
      rollstock_done_at: null,
      reconcile_at: null,
      blast_at: null,
      stored_at: null,
      done_at: null,
      cancelled_at: null,
    };
    expect(
      intakeTimeline({
        ...none,
        intake_at: "2026-07-01T10:00:00Z",
        hold_until: "2026-07-03T10:00:00Z",
        pulled_at: "2026-07-02T08:00:00Z",
      }).map((e) => e.label),
    ).toEqual(["Checked in", "Cooler hold until", "Pulled for processing"]);
  });

  it("hours-in-cooler badge only while holding", () => {
    const now = new Date("2026-07-02T04:30:00Z");
    expect(coolerBadge("holding", "2026-07-01T10:00:00Z", now)).toBe("18h in cooler");
    expect(coolerBadge("processing", "2026-07-01T10:00:00Z", now)).toBeNull();
  });
});
