import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it, expect } from "vitest";
import { renderTagCodeSql } from "./qr";
it("WP12 SQL tag normalization remains generated from QR rules", () => {
  expect(
    readFileSync(
      fileURLToPath(
        new URL(
          "../../../supabase/migrations/20261027045800_tag_normalization.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  ).toBe(renderTagCodeSql());
});
