// Two owners demoting each other at the same time must never leave an org without an owner.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOrg,
  createUser,
  dropOrg,
  localSupabase,
  serviceRoleClient,
  type TestOrg,
  type TestUser,
} from "./testing/local-supabase";

/** Opens a transaction on `client` acting as `user` (an owner of `org`) through RLS. */
async function actAsOwner(client: pg.PoolClient, org: TestOrg, user: TestUser): Promise<void> {
  const claims = { sub: user.id, role: "authenticated", org_id: org.id, app_role: "owner" };
  await client.query("begin");
  await client.query(
    "select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)",
    [JSON.stringify(claims)],
  );
}

const demote = (client: pg.PoolClient, memberId: string) =>
  client.query("select public.admin_set_member_role($1, $2, 'manager')", [randomUUID(), memberId]);

describe("last-owner check under concurrency", () => {
  let org: TestOrg;
  let ownerA: TestUser;
  let ownerB: TestUser;
  let pool: pg.Pool;

  beforeAll(async () => {
    org = await createOrg();
    ownerA = await createUser(org, "owner");
    ownerB = await createUser(org, "owner");
    pool = new pg.Pool({ connectionString: localSupabase().DB_URL, max: 2 });
  });

  afterAll(async () => {
    await pool.end();
    await dropOrg(org);
  });

  async function memberId(user: TestUser): Promise<string> {
    const { data } = await serviceRoleClient()
      .from("org_member")
      .select("id")
      .eq("org_id", org.id)
      .eq("user_id", user.id)
      .single();
    return data?.id ?? "";
  }

  it("two owners demoting each other concurrently leave exactly one owner", async () => {
    const [a, b] = [await memberId(ownerA), await memberId(ownerB)];
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      // Owner A demotes B and holds the transaction open.
      await actAsOwner(c1, org, ownerA);
      await demote(c1, b);

      // Meanwhile owner B demotes A. It must wait for A's change rather than count A's
      // uncommitted demotion of B as "another owner still exists".
      await actAsOwner(c2, org, ownerB);
      let settled = false;
      const second = demote(c2, a).finally(() => {
        settled = true;
      });
      second.catch(() => undefined); // observed below
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(false);

      await c1.query("commit");
      await expect(second).rejects.toMatchObject({ code: "23514" });
      await c2.query("rollback");
    } finally {
      c1.release();
      c2.release();
    }

    const { data: owners } = await serviceRoleClient()
      .from("org_member")
      .select("id")
      .eq("org_id", org.id)
      .eq("role", "owner");
    expect(owners).toEqual([{ id: a }]);
  });
});
