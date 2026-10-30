// #85: creating asset tags must serialise with a tag_digits raise. A raise (admin_update_org)
// holds the org row FOR UPDATE while it re-pads; a concurrent admin_asset_tags must not
// validate against the old width and commit a code the raise never saw. Both orders are
// forced deterministically: the second connection is let go only once it blocks on a lock.
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createOrg, dropOrg, localSupabase, type TestOrg } from "./testing/local-supabase";

let pool: pg.Pool;
let org: TestOrg;

/** Begins a transaction on `c` as a manager of the test org. */
async function beginAsManager(c: pg.PoolClient) {
  await c.query("begin");
  await c.query("set local role authenticated");
  await c.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({
      sub: crypto.randomUUID(),
      role: "authenticated",
      org_id: org.id,
      app_role: "manager",
    }),
  ]);
}

/** admin_update_org with the org's current settings at `digits` (a raise). */
function raise(c: pg.PoolClient, digits: number) {
  return c.query(
    `select public.admin_update_org($1, o.name, o.timezone,
       jsonb_set(o.settings, '{scanner,tag_digits}', to_jsonb($2::int))) as r
     from public.org o`,
    [crypto.randomUUID(), digits],
  );
}

/** admin_asset_tags creating one tag, its code and QR as the Asset tags action builds them. */
function createTag(c: pg.PoolClient, code: string) {
  return c.query("select public.admin_asset_tags($1, $2) as r", [
    crypto.randomUUID(),
    JSON.stringify([{ code, qr: `FL:TAG:${org.slug}:${code}` }]),
  ]);
}

/** A service-role write straight to the table (e.g. scripts/seed-demo-org.ts): no action_log
 * row, so only the canonical trigger's org lock orders it against a raise. */
async function insertTag(c: pg.PoolClient, code: string) {
  await c.query("set local role service_role");
  return c.query("insert into public.asset_tag (org_id, code, qr) values ($1, $2, $3)", [
    org.id,
    code,
    `FL:TAG:${org.slug}:${code}`,
  ]);
}

/** Resolves once `pid` is blocked waiting on a lock. */
async function waitUntilBlocked(pid: number) {
  for (let i = 0; i < 200; i++) {
    const { rows } = await pool.query(
      "select wait_event_type from pg_stat_activity where pid = $1",
      [pid],
    );
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`backend ${pid} never blocked`);
}

async function codes(): Promise<string[]> {
  const { rows } = await pool.query<{ code: string; qr: string }>(
    "select code, qr from public.asset_tag where org_id = $1 order by code",
    [org.id],
  );
  for (const r of rows) expect(r.qr).toBe(`FL:TAG:${org.slug}:${r.code}`);
  return rows.map((r) => r.code);
}

/** Ends any open transaction (a failed assertion leaves one) and returns the clients. */
async function release(...clients: pg.PoolClient[]) {
  for (const c of clients) {
    await c.query("rollback");
    c.release();
  }
}

/** An org from before v1.1: 3-digit tags, holding tag 042. */
async function resetOrg() {
  await pool.query("delete from public.asset_tag where org_id = $1", [org.id]);
  await pool.query(
    `update public.org set settings = jsonb_set(settings, '{scanner,tag_digits}', '3') where id = $1`,
    [org.id],
  );
  await pool.query("insert into public.asset_tag (org_id, code, qr) values ($1, '042', $2)", [
    org.id,
    `FL:TAG:${org.slug}:042`,
  ]);
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: localSupabase().DB_URL, max: 4 });
  org = await createOrg();
  await resetOrg();
});

afterAll(async () => {
  if (org) await dropOrg(org);
  await pool?.end();
});

it.each([
  ["admin_asset_tags", createTag],
  ["a direct service-role insert", insertTag],
] as const)(
  "I85 a tag created during a raise (%s) waits for it and is held to the new width",
  async (_, write) => {
    const raiser = await pool.connect();
    const creator = await pool.connect();
    try {
      await beginAsManager(raiser);
      await raise(raiser, 4); // holds the org row; not committed yet

      await beginAsManager(creator);
      const { rows } = await creator.query<{ pid: number }>("select pg_backend_pid() as pid");
      const created = write(creator, "043").then(
        () => "committed old width",
        (e: { code?: string }) => e.code,
      );
      await waitUntilBlocked(rows[0]!.pid);
      await raiser.query("commit");

      // The old-width code is rejected against the committed width, never stored as 043.
      expect(await created).toBe("23514");
      await creator.query("rollback");
      expect(await codes()).toEqual(["0042"]);
    } finally {
      await release(raiser, creator);
      await resetOrg();
    }
  },
);

it("I85 a raise during a tag creation waits for it and re-pads the new tag", async () => {
  const creator = await pool.connect();
  const raiser = await pool.connect();
  try {
    await beginAsManager(creator);
    await createTag(creator, "044"); // valid at 3 digits; not committed yet

    await beginAsManager(raiser);
    const { rows } = await raiser.query<{ pid: number }>("select pg_backend_pid() as pid");
    const raised = raise(raiser, 4);
    await waitUntilBlocked(rows[0]!.pid);
    await creator.query("commit");

    expect((await raised).rows[0].r).toMatchObject({ tag_digits: 4, repadded_tags: 2 });
    await raiser.query("commit");
    expect(await codes()).toEqual(["0042", "0044"]);
  } finally {
    await release(creator, raiser);
    await resetOrg();
  }
});
