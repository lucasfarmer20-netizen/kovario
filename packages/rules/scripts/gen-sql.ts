// `pnpm --filter rules gen:sql`: writes the generated rules SQL migrations — RULES_SQL_PATH
// from rules-sql.ts, ALLOCATION_SQL_PATH from allocation-sql.ts, REGISTER_SQL_PATH from
// register-sql.ts and RELEASE_SQL_PATH from release-sql.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOCATION_SQL_PATH, renderAllocationSql } from "../src/allocation-sql.ts";
import { REGISTER_SQL_PATH, renderRegisterSql } from "../src/register-sql.ts";
import { RELEASE_SQL_PATH, renderReleaseSql } from "../src/release-sql.ts";
import { RULES_SQL_PATH, renderRulesSql } from "../src/rules-sql.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
for (const [path, render] of [
  [RULES_SQL_PATH, renderRulesSql],
  [ALLOCATION_SQL_PATH, renderAllocationSql],
  [REGISTER_SQL_PATH, renderRegisterSql],
  [RELEASE_SQL_PATH, renderReleaseSql],
] as const) {
  const target = resolve(repoRoot, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, render());
  process.stdout.write(`wrote ${path}\n`);
}
