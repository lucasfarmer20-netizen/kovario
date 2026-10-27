// WP-09 storage pickup invariants that need two connections (the rest are table-driven in
// supabase/tests/09_storage.test.sql):
//   S5 — every batch/box/intake write locks the INTAKE row first: while another transaction
//        holds it, create/release/Force Release wait on it without having locked the batch;
//   S2 — two payments racing for one batch release it once; the loser is a duplicate.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, dropOrg, localSupabase, type TestOrg } from "./testing/local-supabase";

type Role = "staff" | "manager";

async function begin(client: pg.PoolClient, org: TestOrg, role: Role): Promise<void> {
  const claims = { sub: randomUUID(), role: "authenticated", org_id: org.id, app_role: role };
  await client.query("begin");
  await client.query(
    "select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)",
    [JSON.stringify(claims)],
  );
}

/** The paid hook's call (WP-16 runs it inside its own definer function). */
async function beginPaidHook(client: pg.PoolClient, org: TestOrg): Promise<void> {
  const claims = { sub: randomUUID(), role: "authenticated", org_id: org.id, app_role: "cashier" };
  await client.query("begin");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
}

const pay = (client: pg.PoolClient, batchId: string, paymentId: string, ref: string) =>
  client.query<{ r: { status: string }[] }>(
    "select app.release_pickup_batches(array[$1::uuid], $2::uuid, $3) as r",
    [batchId, paymentId, ref],
  );

async function waitingOnLock(pool: pg.Pool, pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    const { rows } = await pool.query<{ w: string | null }>(
      "select wait_event_type as w from pg_stat_activity where pid = $1",
      [pid],
    );
    if (rows[0]?.w === "Lock") return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe("storage pickup batches under concurrency", { timeout: 60_000 }, () => {
  let org: TestOrg;
  let pool: pg.Pool;
  let customerId: string;

  beforeAll(async () => {
    org = await createOrg();
    pool = new pg.Pool({ connectionString: localSupabase().DB_URL, max: 4 });
    const card = await pool.query<{ id: string }>(
      "insert into public.rate_card (org_id, name, is_default) values ($1, 'Std', true) returning id",
      [org.id],
    );
    await pool.query(
      "insert into public.rate_card_line (org_id, rate_card_id, key, amount) values ($1, $2, 'storage_per_box_day', 0.5)",
      [org.id, card.rows[0]!.id],
    );
    const customer = await pool.query<{ id: string }>(
      "insert into public.customer (org_id, name) values ($1, 'Race Customer') returning id",
      [org.id],
    );
    customerId = customer.rows[0]!.id;
  });

  afterAll(async () => {
    await pool.end();
    await dropOrg(org);
  });

  async function storedIntake(boxes: number): Promise<{ intakeId: string; boxIds: string[] }> {
    const c = await pool.connect();
    try {
      await begin(c, org, "staff");
      const { rows } = await c.query<{ r: { storage_intake_id: string } }>(
        "select public.confirm_storage_intake($1, $2) as r",
        [
          randomUUID(),
          { customer_id: customerId, boxes: Array.from({ length: boxes }, () => ({})) },
        ],
      );
      await c.query("commit");
      const intakeId = rows[0]!.r.storage_intake_id;
      const box = await pool.query<{ id: string }>(
        "select id from public.storage_box where storage_intake_id = $1 order by box_no",
        [intakeId],
      );
      return { intakeId, boxIds: box.rows.map((b) => b.id) };
    } finally {
      c.release();
    }
  }

  async function pendingBatch(intakeId: string, boxIds: string[]): Promise<string> {
    const c = await pool.connect();
    try {
      await begin(c, org, "staff");
      const { rows } = await c.query<{ r: { batch_id: string } }>(
        "select public.create_pickup_batch($1, $2, $3) as r",
        [randomUUID(), intakeId, boxIds],
      );
      await c.query("commit");
      return rows[0]!.r.batch_id;
    } finally {
      c.release();
    }
  }

  async function approvedPayment(ref: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `insert into public.payment (org_id, number, customer_id, provider, amount, state, provider_ref)
       values ($1, $2, $3, 'manual', 5, 'approved', $4) returning id`,
      [org.id, `PAY-${ref}`, customerId, ref],
    );
    return rows[0]!.id;
  }

  /**
   * Holds the intake row lock on one connection, starts `act` on another, and checks the
   * second waits on a lock while the batch row itself is still free (S5: intake first).
   */
  async function expectIntakeLockedFirst(
    intakeId: string,
    batchId: string | null,
    act: (c: pg.PoolClient) => Promise<unknown>,
  ): Promise<unknown> {
    const holder = await pool.connect();
    const actor = await pool.connect();
    const probe = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from public.storage_intake where id = $1 for update", [intakeId]);
      const pid = (await actor.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      const pending = act(actor);
      pending.catch(() => undefined); // observed below
      expect(await waitingOnLock(pool, pid)).toBe(true);
      if (batchId) {
        await probe.query("begin");
        // The waiting transaction has not locked the batch: it reads/guards only after the intake.
        await probe.query("select 1 from public.storage_pickup_batch where id = $1 for update nowait", [
          batchId,
        ]);
        await probe.query("rollback");
      }
      await holder.query("commit");
      const result = await pending;
      await actor.query("commit");
      return result;
    } finally {
      holder.release();
      actor.release();
      probe.release();
    }
  }

  it("S5: create_pickup_batch waits on the intake row", async () => {
    const { intakeId, boxIds } = await storedIntake(2);
    const old = await pendingBatch(intakeId, boxIds.slice(0, 1));
    await expectIntakeLockedFirst(intakeId, old, async (c) => {
      await begin(c, org, "staff");
      return c.query("select public.create_pickup_batch($1, $2, $3)", [randomUUID(), intakeId, boxIds]);
    });
    const { rows } = await pool.query<{ state: string }>(
      "select state from public.storage_pickup_batch where id = $1",
      [old],
    );
    expect(rows[0]!.state).toBe("void");
  });

  it("S5: the paid-hook release waits on the intake row", async () => {
    const { intakeId, boxIds } = await storedIntake(1);
    const batch = await pendingBatch(intakeId, boxIds);
    const payment = await approvedPayment("S5-PAY");
    const result = (await expectIntakeLockedFirst(intakeId, batch, async (c) => {
      await beginPaidHook(c, org);
      return pay(c, batch, payment, "S5-PAY");
    })) as pg.QueryResult<{ r: { status: string }[] }>;
    expect(result.rows[0]!.r[0]!.status).toBe("released");
  });

  it("S5: manager Force Release waits on the intake row", async () => {
    const { intakeId, boxIds } = await storedIntake(1);
    const batch = await pendingBatch(intakeId, boxIds);
    await expectIntakeLockedFirst(intakeId, batch, async (c) => {
      await begin(c, org, "manager");
      return c.query("select public.force_release_pickup_batch($1, $2, 'manual', 'race test')", [
        randomUUID(),
        batch,
      ]);
    });
    const { rows } = await pool.query<{ state: string; payment_ref: string }>(
      "select state, payment_ref from public.storage_pickup_batch where id = $1",
      [batch],
    );
    expect(rows[0]).toEqual({ state: "released", payment_ref: "MANUAL" });
  });

  it("S2: two payments racing for one batch release it once", async () => {
    const { intakeId, boxIds } = await storedIntake(2);
    const batch = await pendingBatch(intakeId, boxIds);
    const [p1, p2] = [await approvedPayment("RACE-1"), await approvedPayment("RACE-2")];
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      await beginPaidHook(c1, org);
      await beginPaidHook(c2, org);
      const first = await pay(c1, batch, p1, "RACE-1");
      const second = pay(c2, batch, p2, "RACE-2");
      second.catch(() => undefined); // observed below
      await new Promise((resolve) => setTimeout(resolve, 300));
      await c1.query("commit");
      const late = await second;
      await c2.query("commit");
      expect(first.rows[0]!.r[0]!.status).toBe("released");
      expect(late.rows[0]!.r[0]!.status).toBe("duplicate_payment");
    } finally {
      c1.release();
      c2.release();
    }
    const { rows } = await pool.query<{ payment_ref: string; critical: boolean; boxes: string }>(
      `select b.payment_ref, b.notes ~ '\\[CRITICAL\\]' as critical,
              (select string_agg(x.batch_id::text || ':' || x.state, ',') from public.storage_box x
               where x.storage_intake_id = $2) as boxes
       from public.storage_pickup_batch b where b.id = $1`,
      [batch, intakeId],
    );
    expect(rows[0]).toEqual({
      payment_ref: "RACE-1",
      critical: true,
      boxes: `${batch}:released,${batch}:released`,
    });
  });
});
