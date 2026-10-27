import { describe, expect, it, vi } from "vitest";
import { seedYieldFactor, yieldFactor } from "./yield.ts";

// The shared processing matrix has no smoked-exchange rows, so matrix-allowed exchange
// lines cannot exist yet (#41). Add exchange next to smoking in the salmon rows to pin the
// documented factor lookup (docs/04 §1): chum → reds, exchange → smoking, then both.
vi.mock("./seed.ts", async (importOriginal) => {
  const { SEED } = await importOriginal<typeof import("./seed.ts")>();
  const exchange = ["smoked_exchange_traditional", "smoked_exchange_cajun"];
  return {
    SEED: {
      ...SEED,
      processing_matrix: Object.fromEntries(
        Object.entries(SEED.processing_matrix).map(([key, methods]) => [
          key,
          key.startsWith("salmon|") && methods.includes("smoking")
            ? [...methods, ...exchange]
            : methods,
        ]),
      ),
    },
  };
});

describe("yield fallbacks for matrix-allowed exchange lines", () => {
  it("exchange methods fall back to smoking", () => {
    expect(seedYieldFactor("salmon_kings", "hg", "smoked_exchange_traditional")).toBe(0.52);
    expect(seedYieldFactor("salmon_pinks", "whole", "smoked_exchange_cajun")).toBe(0.39);
  });

  it("chum falls back to reds", () => {
    // Chum has no smoked-exchange rows; reds does.
    expect(seedYieldFactor("salmon_chum", "whole", "smoked_exchange_cajun")).toBe(0.39);
    expect(
      yieldFactor({ species: "salmon_chum", condition: "whole", method: "smoked_exchange_cajun" }),
    ).toBe(0.39);
  });
});
