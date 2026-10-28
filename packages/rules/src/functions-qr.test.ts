import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { QR_FUNCTIONS_PATH, QR_SOURCE_PATH, renderFunctionsQr } from "./functions-qr.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

describe("Edge Functions copy of qr.ts", () => {
  it(`${QR_FUNCTIONS_PATH} is up to date (run \`pnpm --filter rules gen:functions\`)`, () => {
    expect(read(QR_FUNCTIONS_PATH).replaceAll("\r\n", "\n")).toBe(
      renderFunctionsQr(read(QR_SOURCE_PATH)),
    );
  });

  it("is qr.ts verbatim under a GENERATED header", () => {
    const rendered = renderFunctionsQr("export const A = 1;\r\n");
    expect(rendered).toMatch(/^\/\/ GENERATED from packages\/rules\/src\/qr\.ts /);
    expect(rendered.endsWith("\n\nexport const A = 1;\n")).toBe(true);
  });

  it("refuses a qr.ts with imports, which the copy could not resolve", () => {
    expect(() => renderFunctionsQr('import { x } from "./x.ts";\n')).toThrow(/import-free/);
    expect(() => renderFunctionsQr('export { x } from "./x.ts";\n')).toThrow(/import-free/);
  });
});

describe("Edge Functions bundle on the hosted builder", () => {
  // `functions deploy --use-api` ships only supabase/functions/**: a relative import that
  // leaves it fails the deploy with "Module not found" (issue #79).
  const functionsRoot = resolve(repoRoot, "supabase/functions");
  const files = (readdirSync(functionsRoot, { recursive: true }) as string[]).filter((f) =>
    /\.[cm]?[jt]sx?$/.test(f),
  );

  it("no file under supabase/functions imports from outside it", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const path = resolve(functionsRoot, file);
      const text = readFileSync(path, "utf8");
      for (const [, spec = ""] of text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)) {
        if (!spec.startsWith(".")) continue; // npm:, jsr:, https: specifiers resolve remotely
        const target = relative(functionsRoot, resolve(dirname(path), spec));
        expect(target.startsWith(".."), `${file} imports ${spec}`).toBe(false);
      }
    }
  });
});
