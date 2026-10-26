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
const vitestSuites = ["apps", "packages", "agent"].some(
  (d) => existsSync(join(root, d)) && hasDbSuites(join(root, d)),
);

if (sqlTests) run("supabase test db");
if (vitestSuites) run("pnpm -r --if-present test", { KOVARIO_TEST_DB: "1" });
if (!sqlTests && !vitestSuites) console.log("test:db: no SQL or *.db.test.ts suites yet");
