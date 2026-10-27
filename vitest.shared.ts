import { configDefaults, defineConfig } from "vitest/config";

// Unit runs (`pnpm test`) skip `*.db.test.ts`; `pnpm test:db` sets FILLETRY_TEST_DB=1
// to run only those suites against the local Supabase.
const dbMode = process.env.FILLETRY_TEST_DB === "1";
const dbSuites = "**/*.db.test.ts";

export default defineConfig({
  test: {
    passWithNoTests: true,
    // Local Supabase setup shells out once per file; parallel cold starts contend
    // on Windows. Race tests still launch concurrent transactions within a file.
    fileParallelism: !dbMode,
    include: dbMode ? [dbSuites] : configDefaults.include,
    exclude: dbMode ? configDefaults.exclude : [...configDefaults.exclude, dbSuites],
  },
});
