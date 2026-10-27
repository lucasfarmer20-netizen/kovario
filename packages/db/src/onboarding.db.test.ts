// WP-22 signup → create org end to end through PostgREST, with the real processing-rules
// payload (packages/rules referenceSeed()): a brand-new account with no org creates one,
// refreshes its session and lands in the new org as owner with all reference data.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { RATE_CARD_EXTRA_KEYS, referenceSeed } from "../../rules/src/reference-seed.ts";
import { filletryClaims } from "./claims";
import { createUser, dropOrg, type TestOrg, type TestUser } from "./testing/local-supabase";

describe("self-serve onboarding (create_org)", { timeout: 60_000 }, () => {
  let founder: TestUser;
  let org: TestOrg | null = null;
  const seed = referenceSeed();

  afterAll(async () => {
    if (org) await dropOrg(org);
  });

  it("a new account without an org has no org claims", async () => {
    founder = await createUser(null);
    const { data } = await founder.client.auth.getClaims();
    expect(filletryClaims(data?.claims)).toBeNull();
  });

  it("creates the org with the full processing-rules seed and a default rate card", async () => {
    const slug = `wp22-${randomUUID().slice(0, 8)}`;
    const actionId = randomUUID();
    const args = {
      p_client_action_id: actionId,
      p_name: "Kenai Test Plant",
      p_slug: slug,
      p_timezone: "America/Anchorage",
      p_display_name: "Fay Founder",
      p_reference: seed as never,
      p_site_name: "Main",
    };
    const { data, error } = await founder.client.rpc("create_org", args);
    expect(error).toBeNull();
    const result = data as { org_id: string; seeded: Record<string, number> };
    org = { id: result.org_id, slug };

    expect(result.seeded).toEqual({
      species: seed.species.length,
      conditions: seed.conditions.length,
      methods: seed.methods.length,
      condition_matrix: seed.condition_matrix.length,
      processing_matrix: seed.processing_matrix.length,
      yield_factors: 250,
    });

    // A lost response retried with the same id replays instead of creating a second org.
    const replay = await founder.client.rpc("create_org", args);
    expect(replay.data).toEqual(data);
  });

  it("after a session refresh the founder is the owner of the new org", async () => {
    const { error } = await founder.client.auth.refreshSession();
    expect(error).toBeNull();
    const { data } = await founder.client.auth.getClaims();
    expect(filletryClaims(data?.claims)).toMatchObject({ orgId: org?.id, appRole: "owner" });

    const { count: species } = await founder.client
      .from("species")
      .select("id", { count: "exact", head: true });
    const { count: yields } = await founder.client
      .from("yield_factor")
      .select("id", { count: "exact", head: true });
    expect(species).toBe(17);
    expect(yields).toBe(250);
  });

  it("the default rate card has a line per service method plus the named rates", async () => {
    const { data: card } = await founder.client
      .from("rate_card")
      .select("id, is_default, rate_card_line(key, amount)")
      .eq("is_default", true)
      .single();
    const keys = (card?.rate_card_line ?? []).map((l) => l.key).sort();
    const serviceMethods = seed.methods.filter((m) => m.kind === "service").map((m) => m.code);
    expect(keys).toEqual([...serviceMethods, ...RATE_CARD_EXTRA_KEYS].sort());
    expect(keys).not.toContain("fresh");
  });
});
