import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { renderPickupEstimateSql } from "./pickup";

it("WP20 migration pickup helper matches its single rules source", () => {
  const migration = readFileSync(
    new URL(
      "../../../supabase/migrations/20261028120000_customer_status_email.sql",
      import.meta.url,
    ),
    "utf8",
  ).replaceAll("\r\n", "\n");
  expect(migration).toContain(renderPickupEstimateSql());
});
