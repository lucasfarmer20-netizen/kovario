// #87 variance hold: the generated SQL rules agree with packages/rules variance.ts, and Send to
// Blast serialises per org so a flag and a neighbour's send can never both pass (AGENTS rule 3:
// the org's variance lock → the intake's reconcile lock → vessels → intake → hold rows). Both
// orders are forced deterministically: the second send is let go only once it blocks on a lock.
// Every other case (V1…) is in supabase/tests/27_variance_hold.test.sql.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  holdGroup,
  variancePercent,
  varianceBand,
  varianceHoldLimit,
  varianceHoldSettingProblem,
  varianceSignoffProblem,
} from "../../rules/src/index.ts";
import { createOrg, dropOrg, localSupabase, type TestOrg } from "./testing/local-supabase";

let pool: pg.Pool;
let org: TestOrg;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: localSupabase().DB_URL, max: 4 });
  org = await createOrg();
});

afterAll(async () => {
  if (org) await dropOrg(org);
  await pool?.end();
});

describe("generated variance SQL ≡ variance.ts", () => {
  it("variance % and band over a grid", async () => {
    const weights = [
      0, 0.01, 31, 32, 33, 42.5, 42.49, 44, 45, 50, 55, 56.67, 57.5, 57.51, 70, 1000,
    ];
    for (const expected of [0, 0.01, 32, 50]) {
      for (const actual of weights) {
        for (const limit of [1, 15, 20, 100]) {
          const { rows } = await pool.query<{ pct: string | null; band: string }>(
            "select app.variance_pct($1, $2) as pct, app.variance_band($1, $2, $3) as band",
            [actual, expected, limit],
          );
          const where = `actual=${actual} expected=${expected} limit=${limit}`;
          expect(rows[0]!.band, where).toBe(varianceBand(actual, expected, limit));
          const pct = rows[0]!.pct === null ? null : Number(rows[0]!.pct);
          expect(pct, where).toBe(variancePercent(actual, expected));
        }
      }
    }
  });

  it("hold group over sequences", async () => {
    const seq = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
    const stranger = "00000000-0000-4000-8000-0000000000ff";
    for (const sequence of [seq, seq.slice(0, 1), seq.slice(0, 2), []]) {
      for (const flagged of [...sequence, stranger]) {
        const { rows } = await pool.query<{ g: string[] }>(
          "select app.variance_hold_group($1::uuid[], $2) as g",
          [sequence, flagged],
        );
        expect(rows[0]!.g).toEqual(holdGroup(sequence, flagged));
      }
    }
  });

  it("setting, limit and sign-off checks", async () => {
    for (const settings of [
      {},
      { reconcile: { variance_hold_pct: 15 } },
      { reconcile: { variance_hold_pct: 1 } },
      { reconcile: { variance_hold_pct: 0 } },
      { reconcile: { variance_hold_pct: 12.5 } },
      { reconcile: { variance_hold_pct: "15" } },
      { reconcile: { variance_hold_pct: 15, x: 1 } },
      { reconcile: [] },
    ]) {
      const { rows } = await pool.query<{ problem: string | null }>(
        "select app.variance_hold_setting_problem($1) as problem",
        [settings],
      );
      expect(rows[0]!.problem, JSON.stringify(settings)).toBe(varianceHoldSettingProblem(settings));
      if (rows[0]!.problem === null) {
        const limit = await pool.query<{ l: number }>("select app.variance_hold_limit($1) as l", [
          settings,
        ]);
        expect(limit.rows[0]!.l).toBe(varianceHoldLimit(settings));
      }
    }
    for (const reason of ["estimate_wrong", "other", "nope"]) {
      for (const note of [null, "", " \t", "Bled", "x".repeat(501)]) {
        const { rows } = await pool.query<{ problem: string | null }>(
          "select app.variance_signoff_problem($1, $2) as problem",
          [reason, note],
        );
        expect(rows[0]!.problem, `${reason} ${note}`).toBe(varianceSignoffProblem(reason, note));
      }
    }
  });
});

/** Two intakes at reconcile, opened at rollstock A then B, each expecting 50 lb: A at 70 lb
 * (+40%, over ±15%) and B at 50 lb. B is A's first neighbour after. */
async function fixture(): Promise<{ a: string; b: string }> {
  await pool.query("delete from public.variance_hold where org_id = $1", [org.id]);
  await pool.query("delete from public.vessel where org_id = $1", [org.id]);
  await pool.query("delete from public.intake where org_id = $1", [org.id]);
  const { rows: refs } = await pool.query<{ site: string; customer: string }>(
    `with s as (insert into public.site (org_id, name) values ($1, 'Line ' || gen_random_uuid()) returning id),
          c as (insert into public.customer (org_id, name) values ($1, 'Race') returning id)
     select s.id as site, c.id as customer from s, c`,
    [org.id],
  );
  for (const sql of [
    `insert into public.species (org_id, code, name, "group") values ($1, 'salmon', 'Salmon', 'salmon')`,
    "insert into public.incoming_condition (org_id, code, name) values ($1, 'whole', 'Whole')",
    "insert into public.processing_method (org_id, code, name) values ($1, 'fillets', 'Fillets')",
  ])
    await pool.query(`${sql} on conflict do nothing`, [org.id]);
  const ids: string[] = [];
  for (const [n, lb] of [
    [1, 70],
    [2, 50],
  ] as const) {
    const { rows } = await pool.query<{ id: string }>(
      `insert into public.intake (org_id, number, customer_id, site_id, tote_count)
       values ($1, $2, $3, $4, 1) returning id`,
      [org.id, `INT-000${n}`, refs[0]!.customer, refs[0]!.site],
    );
    const id = rows[0]!.id;
    await pool.query(
      `insert into public.intake_line (org_id, intake_id, species_code, condition_code, method_code, lb, yield_factor)
       values ($1, $2, 'salmon', 'whole', 'fillets', 100, 0.5)`,
      [org.id, id],
    );
    for (const state of ["holding", "processing", "rollstock", "reconcile"])
      await pool.query("update public.intake set state = $2 where id = $1", [id, state]);
    await pool.query(
      `insert into public.scan_log (org_id, station, raw, result, intake_id, scanned_at)
       values ($1, 'rollstock', 'FL:TOTE', 'ok', $2, now() + make_interval(mins => $3))`,
      [org.id, id, n],
    );
    await pool.query(
      `insert into public.vessel (org_id, intake_id, is_exchange, weight_lb) values ($1, $2, true, $3)`,
      [org.id, id, lb],
    );
    ids.push(id);
  }
  return { a: ids[0]!, b: ids[1]! };
}

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

function send(c: pg.PoolClient, intakeId: string) {
  return c
    .query<{ r: { ok: boolean; reason: string } }>("select public.send_to_blast($1, $2) as r", [
      crypto.randomUUID(),
      intakeId,
    ])
    .then((q) => q.rows[0]!.r);
}

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

async function release(...clients: pg.PoolClient[]) {
  for (const c of clients) {
    await c.query("rollback");
    c.release();
  }
}

async function state(id: string): Promise<string> {
  const { rows } = await pool.query<{ state: string }>(
    "select state from public.intake where id = $1",
    [id],
  );
  return rows[0]!.state;
}

describe("Send to Blast serialises flags and neighbours", () => {
  it("V-race a neighbour sent while the flag is uncommitted waits, then is blocked", async () => {
    const { a, b } = await fixture();
    const flagger = await pool.connect();
    const neighbour = await pool.connect();
    try {
      await beginAsManager(flagger);
      expect((await send(flagger, a)).ok).toBe(false); // flags; not committed yet

      await beginAsManager(neighbour);
      const { rows } = await neighbour.query<{ pid: number }>("select pg_backend_pid() as pid");
      const sent = send(neighbour, b);
      await waitUntilBlocked(rows[0]!.pid);
      await flagger.query("commit");

      expect((await sent).reason).toMatch(
        /^Variance hold on INT-\d{4}: INT-\d{4} is its rollstock neighbour/,
      );
      await neighbour.query("commit");
      expect(await state(b)).toBe("reconcile");
    } finally {
      await release(flagger, neighbour);
    }
  });

  it("V-race a flag during a neighbour's send waits; the neighbour is already in blast", async () => {
    const { a, b } = await fixture();
    const neighbour = await pool.connect();
    const flagger = await pool.connect();
    try {
      await beginAsManager(neighbour);
      expect((await send(neighbour, b)).ok).toBe(true); // not committed yet

      await beginAsManager(flagger);
      const { rows } = await flagger.query<{ pid: number }>("select pg_backend_pid() as pid");
      const flagged = send(flagger, a);
      await waitUntilBlocked(rows[0]!.pid);
      await neighbour.query("commit");

      expect((await flagged).ok).toBe(false);
      await flagger.query("commit");
      expect(await state(b)).toBe("blast_freezer");
      const { rows: members } = await pool.query<{ intake_id: string; blocked: boolean }>(
        "select intake_id, blocked from public.variance_hold_member where org_id = $1 order by position",
        [org.id],
      );
      // variance_hold_member is security-invoker; as the table owner the pool sees every row.
      expect(members).toEqual([
        { intake_id: a, blocked: true },
        { intake_id: b, blocked: false },
      ]);
    } finally {
      await release(neighbour, flagger);
    }
  });
});
