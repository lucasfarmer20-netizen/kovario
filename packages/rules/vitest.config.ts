import { defineConfig, mergeConfig } from "vitest/config";
import shared from "../../vitest.shared.ts";

// Issue #6: 100% branch coverage on pricing and yield; `pnpm test` enforces it.
const full = { branches: 100, functions: 100, lines: 100, statements: 100 };

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      coverage: {
        provider: "v8",
        include: ["src/**/*.ts"],
        exclude: ["src/**/*.test.ts"],
        reporter: ["text", "json-summary"],
        thresholds: {
          "src/pricing.ts": full,
          "src/yield.ts": full,
        },
      },
    },
  }),
);
