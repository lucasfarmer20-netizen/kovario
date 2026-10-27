import { describe, expect, it, vi } from "vitest";
import { yieldFactor } from "./yield.ts";

// Every matrix-allowed fresh combination has both seed sides today, so drop one row to
// pin the behaviour if the seed ever gains a gap: an allowed combination with no factor
// is `null`, not an error (#41).
vi.mock("./seed.ts", async (importOriginal) => {
  const { SEED } = await importOriginal<typeof import("./seed.ts")>();
  return {
    SEED: {
      ...SEED,
      yield_table: SEED.yield_table.filter(
        (r) =>
          !(r.species === "salmon_kings" && r.condition === "whole" && r.processing === "fillets"),
      ),
    },
  };
});

describe("yieldFactor with a seed gap", () => {
  const base = { species: "salmon_kings", condition: "whole", method: "fresh" } as const;

  it("allowed fresh with a missing side → null", () => {
    expect(yieldFactor({ ...base, filletsPct: 10 })).toBeNull();
    expect(yieldFactor({ ...base, filletsPct: 100 })).toBeNull();
  });

  it("the unused side is not consulted", () => {
    expect(yieldFactor({ ...base, filletsPct: 0 })).toBe(0.52);
  });
});
