// `pnpm --filter rules gen:states`: writes the state_transitions migration (STATE_TRANSITIONS_SQL_PATH) from states.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_TRANSITIONS_SQL_PATH, renderStateTransitionsSql } from "../src/states-sql.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const target = resolve(repoRoot, STATE_TRANSITIONS_SQL_PATH);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, renderStateTransitionsSql());
process.stdout.write(`wrote ${STATE_TRANSITIONS_SQL_PATH}\n`);
