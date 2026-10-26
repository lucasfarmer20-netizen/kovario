import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// AGENTS.md rule 8: packages/rules is pure TS with no runtime deps.
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("rules package purity", () => {
  it("declares no runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });

  it("library source imports only relative modules and the seed", () => {
    const src = resolve(pkgRoot, "src");
    for (const file of readdirSync(src).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    )) {
      const text = readFileSync(resolve(src, file), "utf8");
      for (const [, spec] of text.matchAll(/from\s+"([^"]+)"/g)) {
        expect(spec, `${file} imports ${spec}`).toMatch(/^\.\.?\//);
      }
    }
  });
});
