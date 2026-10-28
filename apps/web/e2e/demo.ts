import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";

/** The demo tenant from supabase/seed.sql + `pnpm db:seed-demo`. */
export const ORG_SLUG = "demo-plant";

/** The e2e owner (created by global-setup through scripts/demo-owner.mjs; local stack only). */
export const OWNER_EMAIL = "e2e-owner@demo-plant.test";

/** Signed-in owner session (cookies), written by global-setup; gitignored. */
export const STORAGE_STATE = fileURLToPath(new URL("./.auth/owner.json", import.meta.url));

/** A rack location built by the demo seed (never archived; no capacity gate). */
export const LOCATION_CODE = "IF-A-02-2-R";

/**
 * A fresh customer per run: a random 907-555 number, so the status page lookup and the
 * register's "Load outstanding" see only this run's records, even on a reused local stack.
 */
export function freshCustomer(label: string): { name: string; phone: string; digits: string } {
  const line = String(randomInt(2000, 10_000)).padStart(4, "0");
  const digits = `907555${line}`;
  return { name: `E2E ${label} ${line}`, phone: `+1${digits}`, digits };
}
