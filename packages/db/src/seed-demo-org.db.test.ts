// WP-22 scripts/seed-demo-org.ts (`pnpm db:seed-demo`): the demo org e2e relies on. Runs the
// script twice against the local stack and checks it covers every intake state with
// consistent tags, vessels and locations, and that the second run changes nothing.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { serviceRoleClient } from "./testing/local-supabase";
import { Constants } from "./types";

const DEMO_ORG = "00000000-0000-4000-8000-000000000001";
const root = fileURLToPath(new URL("../../..", import.meta.url));

function seed(): void {
  execFileSync(process.execPath, ["--experimental-strip-types", "scripts/seed-demo-org.ts"], {
    cwd: root,
    stdio: "pipe",
  });
}

const TABLES = [
  "species",
  "yield_factor",
  "rate_card_line",
  "customer",
  "asset_tag",
  "location",
  "intake",
  "intake_line",
  "tote_tag",
  "vessel",
  "location_placement",
] as const;

async function counts(): Promise<Record<string, number>> {
  const admin = serviceRoleClient();
  const entries = await Promise.all(
    TABLES.map(async (t) => {
      const { count, error } = await admin
        .from(t)
        .select("id", { count: "exact", head: true })
        .eq("org_id", DEMO_ORG);
      if (error) throw error;
      return [t, count ?? 0] as const;
    }),
  );
  return Object.fromEntries(entries);
}

describe("seed-demo-org (demo-plant for e2e)", { timeout: 120_000 }, () => {
  let first: Record<string, number>;

  // Shells out to the script (and `supabase status`): slower than vitest's 10 s hook default
  // while other db suites load the database in parallel.
  beforeAll(async () => {
    seed();
    first = await counts();
  }, 120_000);

  it("has an intake in every intake state", async () => {
    const { data } = await serviceRoleClient()
      .from("intake")
      .select("state")
      .eq("org_id", DEMO_ORG);
    const states = new Set((data ?? []).map((r) => r.state));
    expect([...Constants.public.Enums.intake_state].filter((s) => !states.has(s))).toEqual([]);
  });

  it("seeds the processing rules, customers, tags and locations", () => {
    expect(first.species).toBe(17);
    expect(first.yield_factor).toBe(250);
    expect(first.customer).toBeGreaterThanOrEqual(8);
    expect(first.asset_tag).toBeGreaterThanOrEqual(20);
    expect(first.location).toBeGreaterThanOrEqual(9);
  });

  it("tags in use are bound to occupied vessels; the stored vessel has a live location", async () => {
    const admin = serviceRoleClient();
    const { data: tags } = await admin
      .from("asset_tag")
      .select(
        "code, state, current_vessel_id, vessel!asset_tag_current_vessel_id_fkey(lifecycle_state, asset_tag_id)",
      )
      .eq("org_id", DEMO_ORG)
      .eq("state", "in_use");
    expect(tags?.length).toBeGreaterThan(0);
    for (const t of tags ?? []) {
      expect(t.vessel).toMatchObject({ lifecycle_state: "occupied" });
    }
    const { data: stored } = await admin
      .from("intake")
      .select("number, vessel(lifecycle_state, location_id)")
      .eq("org_id", DEMO_ORG)
      .eq("state", "stored")
      .single();
    expect(stored?.vessel.every((v) => v.lifecycle_state === "occupied" && v.location_id)).toBe(
      true,
    );
  });

  it("every intake past draft has its X-of-Y tote tags", async () => {
    const { data } = await serviceRoleClient()
      .from("intake")
      .select("number, state, tote_count, tote_tag(tote_no)")
      .eq("org_id", DEMO_ORG)
      .neq("state", "draft");
    for (const i of data ?? []) expect(i.tote_tag).toHaveLength(i.tote_count);
  });

  it("the intake counter continues after the highest seeded number", async () => {
    const admin = serviceRoleClient();
    const { data: intakes } = await admin.from("intake").select("number").eq("org_id", DEMO_ORG);
    const highest = Math.max(...(intakes ?? []).map((i) => Number(i.number.slice(4))));
    const { data: counter } = await admin
      .from("sequence_counter")
      .select("value")
      .eq("org_id", DEMO_ORG)
      .eq("kind", "intake")
      .single();
    expect(counter?.value).toBeGreaterThanOrEqual(highest);
  });

  it("is idempotent: a second run adds nothing", async () => {
    seed();
    expect(await counts()).toEqual(first);
  });
});
