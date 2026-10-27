import { describe, expect, it } from "vitest";
import { boxRollup, confirmPayload, daysLabel, toggleBox, type BoxRow } from "./storage-state";

const row = (weight: string, description = ""): BoxRow => ({
  key: crypto.randomUUID(),
  weight,
  description,
});

describe("confirmPayload", () => {
  it("builds the confirm_storage_intake payload from the box rows", () => {
    expect(
      confirmPayload({
        customerId: "c1",
        locationId: "",
        notes: "  top shelf ",
        rows: [row("20", " halibut "), row("")],
      }),
    ).toEqual({
      payload: {
        customer_id: "c1",
        location_id: null,
        notes: "top shelf",
        boxes: [
          { weight_lb: 20, description: "halibut" },
          { weight_lb: null, description: null },
        ],
      },
    });
  });

  it("reports a missing customer, no boxes and bad weights", () => {
    expect(
      confirmPayload({
        customerId: null,
        locationId: "",
        notes: "",
        rows: [],
      }),
    ).toEqual({ errors: ["Pick or create the customer.", "Add at least one box."] });
    expect(
      confirmPayload({
        customerId: "c1",
        locationId: "l1",
        notes: "",
        rows: [row("-2"), row("heavy")],
      }),
    ).toEqual({
      errors: [
        "Box 1: weight must be a number of lb (0 or more).",
        "Box 2: weight must be a number of lb (0 or more).",
      ],
    });
  });
});

describe("pickup selection and rollups", () => {
  it("only stored boxes can be selected; selected ones toggle off", () => {
    expect(toggleBox([], "b1", true)).toEqual(["b1"]);
    expect(toggleBox(["b1"], "b2", false)).toEqual(["b1"]);
    expect(toggleBox(["b1", "b2"], "b1", true)).toEqual(["b2"]);
  });

  it("rolls boxes up for the queue", () => {
    expect(boxRollup(3, 3)).toBe("3 boxes stored");
    expect(boxRollup(1, 1)).toBe("1 box stored");
    expect(boxRollup(2, 5)).toBe("2 of 5 boxes left");
    expect(boxRollup(0, 4)).toBe("All 4 picked up");
    expect(daysLabel(1)).toBe("1 day");
    expect(daysLabel(12)).toBe("12 days");
  });
});
