// `pnpm --filter rules gen:functions`: writes the Edge Functions copy of qr.ts
// (QR_FUNCTIONS_PATH from functions-qr.ts).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QR_FUNCTIONS_PATH, QR_SOURCE_PATH, renderFunctionsQr } from "../src/functions-qr.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = readFileSync(resolve(repoRoot, QR_SOURCE_PATH), "utf8");
writeFileSync(resolve(repoRoot, QR_FUNCTIONS_PATH), renderFunctionsQr(source));
process.stdout.write(`wrote ${QR_FUNCTIONS_PATH}\n`);
