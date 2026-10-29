import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it, expect } from "vitest";
import { renderTagCodeSql, TAG_SQL_PATH } from "./qr";
it("WP12 SQL tag normalization remains generated from QR rules", () => {
  expect(
    readFileSync(fileURLToPath(new URL(`../../../${TAG_SQL_PATH}`, import.meta.url)), "utf8"),
  ).toBe(renderTagCodeSql());
});
