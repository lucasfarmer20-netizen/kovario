// `pnpm test:db`: SQL tests (`supabase test db`) when supabase/tests/*.sql exist, then
// vitest `*.db.test.ts` suites. Needs `supabase start`. Exits 0 when there are none.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const skip = new Set(["node_modules", ".next", ".git", "dist", "coverage"]);

function hasDbSuites(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory() ? hasDbSuites(path) : entry.name.endsWith(".db.test.ts")) return true;
  }
  return false;
}

function run(command, env = {}) {
  const result = spawnSync(command, {
    cwd: root,
    shell: true,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const sqlDir = join(root, "supabase", "tests");
const sqlTests = existsSync(sqlDir) && readdirSync(sqlDir).some((f) => f.endsWith(".sql"));
// Workspace packages (apps/*, packages/*, agent/*) that contain *.db.test.ts suites.
const dbPackages = ["apps", "packages", "agent"]
  .filter((d) => existsSync(join(root, d)))
  .flatMap((d) =>
    readdirSync(join(root, d), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(d, e.name)),
  )
  .filter((pkg) => hasDbSuites(join(root, pkg)));

if (sqlTests) run("supabase test db");
// Run vitest directly (not each package's `test` script): DB mode selects only
// *.db.test.ts, so unit-run flags such as rules' `--coverage` thresholds don't apply.
for (const pkg of dbPackages) run(`pnpm --dir ${pkg} exec vitest run`, { FILLETRY_TEST_DB: "1" });
if (!sqlTests && dbPackages.length === 0) console.log("test:db: no SQL or *.db.test.ts suites yet");
