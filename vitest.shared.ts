import { configDefaults, defineConfig } from "vitest/config";

// Unit runs (`pnpm test`) skip `*.db.test.ts`; `pnpm test:db` sets KOVARIO_TEST_DB=1
// to run only those suites against the local Supabase.
const dbMode = process.env.KOVARIO_TEST_DB === "1";
const dbSuites = "**/*.db.test.ts";

export default defineConfig({
  test: {
    passWithNoTests: true,
    include: dbMode ? [dbSuites] : configDefaults.include,
    exclude: dbMode ? configDefaults.exclude : [...configDefaults.exclude, dbSuites],
  },
});
