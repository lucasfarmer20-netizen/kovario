// WP-14: concurrent saves of two priced sessions that share an intake must not deadlock. Each
// save locks its own session and then reprices the other; without the org billing lock
// (app.lock_allocation_billing) the two lock in opposite orders. The interleaving is forced
// deterministically with a third connection holding session A's row.
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createOrg, dropOrg, localSupabase, type TestOrg } from "./testing/local-supabase";

type Summary = {
  session_id: string;
  settlements: { settlement_id: string; angler_name: string; processing_share: string }[];
  pool: { total: string };
};

let pool: pg.Pool;
let org: TestOrg;
const ids = { a: "", b: "" };
const payloads: Record<"a" | "b", Record<string, unknown>> = { a: {}, b: {} };

/** Begins a transaction on `c` as a staff member of the test org. */
async function beginAsStaff(c: pg.PoolClient) {
  await c.query("begin");
  await c.query("set local role authenticated");
  await c.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({
      sub: crypto.randomUUID(),
      role: "authenticated",
      org_id: org.id,
      app_role: "staff",
    }),
  ]);
}

async function call<T>(c: pg.PoolClient, fn: string, ...args: unknown[]): Promise<T> {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await c.query(`select public.${fn}(${params}) as r`, args);
  return rows[0].r as T;
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

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: localSupabase().DB_URL, max: 6 });
  org = await createOrg();
  await pool.query(
    `insert into public.species (org_id, code, name, "group") values ($1, 'salmon_kings', 'Kings', 'salmon');
     insert into public.processing_method (org_id, code, name, kind) values ($1, 'fillets', 'Fillets', 'service');
     insert into public.customer (org_id, name, phone) values ($1, 'Party', '+19075551488');`.replaceAll(
      "$1",
      `'${org.id}'`,
    ),
  );
  const { rows: intakes } = await pool.query<{ id: string; number: string }>(
    `insert into public.intake (org_id, number, customer_id, tote_count)
     select $1, n, (select id from public.customer where org_id = $1), 1
     from unnest(array['INT-0001', 'INT-0002', 'INT-0003']) n
     returning id, number`,
    [org.id],
  );
  const intake = Object.fromEntries(intakes.map((r) => [r.number, r.id]));
  await pool.query("update public.intake set state = 'holding' where org_id = $1", [org.id]);
  await pool.query(
    `insert into public.charge (org_id, number, customer_id, kind, source_type, source_id, qty, unit, unit_price)
     select $1, 'CHG-000' || x.n, i.customer_id, 'processing', 'intake', i.id, x.qty, 'lb', 1
     from (values (1, 'INT-0001', 30.01), (2, 'INT-0002', 20), (3, 'INT-0003', 10)) x (n, num, qty)
     join public.intake i on i.org_id = $1 and i.number = x.num`,
    [org.id],
  );

  // A pools INT-0001 + INT-0002, B pools INT-0001 + INT-0003; both priced.
  const c = await pool.connect();
  try {
    await beginAsStaff(c);
    for (const [k, extra] of [
      ["a", "INT-0002"],
      ["b", "INT-0003"],
    ] as const) {
      const base = {
        split_method: "even",
        intake_ids: [intake["INT-0001"], intake[extra]],
        settlements: ["Ann", "Bo"].map((angler_name) => ({
          angler_name,
          species: [{ species_code: "salmon_kings", method_code: "fillets", lb: 10 }],
          boxes: [],
        })),
      };
      const saved = await call<Summary>(c, "save_allocation_session", crypto.randomUUID(), base);
      ids[k] = saved.session_id;
      await call(c, "price_session", crypto.randomUUID(), saved.session_id);
      // The same session again, now with its stored ids: a re-save reprices A and B.
      payloads[k] = {
        ...base,
        session_id: saved.session_id,
        settlements: base.settlements.map((s, i) => ({
          ...s,
          id: saved.settlements[i]!.settlement_id,
        })),
      };
    }
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}, 60_000);

afterAll(async () => {
  if (org) await dropOrg(org);
  await pool?.end();
});

it("concurrent saves of two priced sessions sharing an intake do not deadlock", async () => {
  const blocker = await pool.connect();
  const t1 = await pool.connect();
  const t2 = await pool.connect();
  try {
    // A third party holds session A's row (e.g. a release in progress).
    await blocker.query("begin");
    await blocker.query("select 1 from public.allocation_session where id = $1 for update", [
      ids.a,
    ]);

    // t1: save A — queues on A's row.
    const t1Pid = (await t1.query("select pg_backend_pid() as p")).rows[0].p as number;
    await beginAsStaff(t1);
    const saveA = call(t1, "save_allocation_session", crypto.randomUUID(), payloads.a).then(
      () => "ok",
      (e: { code?: string; message: string }) => e.code ?? e.message,
    );
    await waitUntilBlocked(t1Pid);

    // t2: save B — without the billing lock it holds B and queues on A behind t1, so when the
    // blocker lets go t1 takes A and waits for B: a deadlock. With it, t2 waits for t1.
    const t2Pid = (await t2.query("select pg_backend_pid() as p")).rows[0].p as number;
    await beginAsStaff(t2);
    const saveB = call(t2, "save_allocation_session", crypto.randomUUID(), payloads.b).then(
      () => "ok",
      (e: { code?: string; message: string }) => e.code ?? e.message,
    );
    await waitUntilBlocked(t2Pid);

    await blocker.query("commit");
    const r1 = await saveA;
    await t1.query(r1 === "ok" ? "commit" : "rollback");
    const r2 = await saveB;
    await t2.query(r2 === "ok" ? "commit" : "rollback");
    expect([r1, r2]).toEqual(["ok", "ok"]); // 40P01 would be a deadlock

    // Both stay priced and still split exactly what they bill (A bills the shared intake).
    const { rows } = await pool.query<{ id: string; state: string; shares: string }>(
      `select s.id, s.state, sum(st.processing_share)::text as shares
       from public.allocation_session s join public.settlement st on st.session_id = s.id
       where s.id = any($1) group by s.id, s.state`,
      [[ids.a, ids.b]],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[ids.a]).toMatchObject({ state: "priced", shares: "50.01" });
    expect(byId[ids.b]).toMatchObject({ state: "priced", shares: "10.00" });
  } finally {
    for (const c of [blocker, t1, t2]) {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
  }
}, 60_000);
