// `pnpm --filter rules gen:sql`: writes the rules SQL migration (RULES_SQL_PATH) from rules-sql.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RULES_SQL_PATH, renderRulesSql } from "../src/rules-sql.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const target = resolve(repoRoot, RULES_SQL_PATH);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, renderRulesSql());
process.stdout.write(`wrote ${RULES_SQL_PATH}\n`);
