// #88 suspect picker, move bin, pull back: the generated SQL rules agree with packages/rules
// suspects.ts, and a bin move serialises with sends and other moves (AGENTS rule 3: the org's
// variance lock → each intake's reconcile lock → vessels → intakes, sorted ids → hold rows), so
// two opposite moves never deadlock and a move re-checks the intakes under its locks. The
// interleavings are forced: the second transaction is let go only once it blocks on a lock.
// Every other case (PK-G…, PK-M…, PK-B…) is in supabase/tests/28_suspect_picker.test.sql.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  STATES,
  binMovable,
  binMoveProblem,
  pullBackProblem,
  suspectStatus,
  suspectWaiting,
  SUSPECT_STATUSES,
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

describe("generated suspect SQL ≡ suspects.ts", () => {
  it("status, waiting and bin-movable over every intake state", async () => {
    for (const state of STATES.intake) {
      for (const [vessels, unweighed] of [
        [0, 0],
        [1, 0],
        [2, 1],
        [3, 3],
      ] as const) {
        const { rows } = await pool.query<{ status: string; movable: boolean }>(
          "select app.suspect_status($1, $2, $3) as status, app.bin_movable($1) as movable",
          [state, vessels, unweighed],
        );
        expect(rows[0], `${state} ${vessels}/${unweighed}`).toEqual({
          status: suspectStatus(state, vessels, unweighed),
          movable: binMovable(state),
        });
      }
    }
    for (const status of [...SUSPECT_STATUSES, "nope", null]) {
      const { rows } = await pool.query<{ waiting: boolean }>(
        "select app.suspect_waiting($1) as waiting",
        [status],
      );
      expect(rows[0]!.waiting, String(status)).toBe(
        status !== null && (SUSPECT_STATUSES as readonly string[]).includes(status)
          ? suspectWaiting(status as (typeof SUSPECT_STATUSES)[number])
          : false,
      );
    }
  });

  it("pull back and bin move checks over every intake state, reason and fact", async () => {
    for (const state of STATES.intake) {
      for (const reason of [null, "", " \t", "Wrong bin", "x".repeat(500), "x".repeat(501)]) {
        for (const [vesselsNotOccupied, poolingSessions] of [
          [0, 0],
          [1, 0],
          [0, 2],
          [3, 1],
        ] as const) {
          const { rows } = await pool.query<{ problem: string | null }>(
            "select app.pull_back_problem($1, $2, $3, $4) as problem",
            [state, reason, vesselsNotOccupied, poolingSessions],
          );
          expect(rows[0]!.problem, `${state} ${reason?.length} ${vesselsNotOccupied}`).toBe(
            pullBackProblem(state, reason, { vesselsNotOccupied, poolingSessions }),
          );
        }
      }
      for (const pooling of [0, 1]) {
        const { rows } = await pool.query<{ problem: string | null }>(
          "select app.bin_move_problem($1, $2, $3) as problem",
          ["INT-0042", state, pooling],
        );
        expect(rows[0]!.problem, `${state} ${pooling}`).toBe(
          binMoveProblem("INT-0042", state, pooling),
        );
      }
    }
  });
});

/** (intake_history is append-only; deleting the intakes cascades it.) Two intakes at reconcile, opened at rollstock A then B (one group), each expecting 50 lb, each
 * with one exchange bin: A's 20 lb and B's 30 lb, plus A's 50 lb (A 70 lb, B 30 lb). */
async function fixture(): Promise<{ a: string; b: string; binA: string; binB: string }> {
  await pool.query("delete from public.variance_hold where org_id = $1", [org.id]);
  await pool.query("delete from public.intake_blast_send where org_id = $1", [org.id]);
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
  const bins: string[] = [];
  for (const [n, lbs] of [
    [1, [20, 50]],
    [2, [30]],
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
    for (const [i, lb] of lbs.entries()) {
      const { rows: v } = await pool.query<{ id: string }>(
        `insert into public.vessel (org_id, intake_id, is_exchange, weight_lb) values ($1, $2, true, $3) returning id`,
        [org.id, id, lb],
      );
      if (i === 0) bins.push(v[0]!.id);
    }
    ids.push(id);
  }
  return { a: ids[0]!, b: ids[1]!, binA: bins[0]!, binB: bins[1]! };
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

type Reply = { ok: boolean; reason: string; moved?: boolean };

function move(c: pg.PoolClient, vesselId: string, to: string, center: string) {
  return c
    .query<{ r: Reply }>("select public.variance_move_vessel($1, $2, $3, $4) as r", [
      crypto.randomUUID(),
      vesselId,
      to,
      center,
    ])
    .then((q) => q.rows[0]!.r);
}

function send(c: pg.PoolClient, intakeId: string) {
  return c
    .query<{ r: Reply }>("select public.send_to_blast($1, $2) as r", [
      crypto.randomUUID(),
      intakeId,
    ])
    .then((q) => q.rows[0]!.r);
}

async function pid(c: pg.PoolClient): Promise<number> {
  const { rows } = await c.query<{ pid: number }>("select pg_backend_pid() as pid");
  return rows[0]!.pid;
}

async function waitUntilBlocked(backend: number) {
  for (let i = 0; i < 200; i++) {
    const { rows } = await pool.query(
      "select wait_event_type from pg_stat_activity where pid = $1",
      [backend],
    );
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`backend ${backend} never blocked`);
}

async function release(...clients: pg.PoolClient[]) {
  for (const c of clients) {
    await c.query("rollback");
    c.release();
  }
}

async function intakeOf(vesselId: string): Promise<string> {
  const { rows } = await pool.query<{ intake_id: string }>(
    "select intake_id from public.vessel where id = $1",
    [vesselId],
  );
  return rows[0]!.intake_id;
}

describe("Move bin serialises with moves and sends", () => {
  it("PK-race two opposite moves between the same intakes: the second waits, then both apply", async () => {
    const { a, b, binA, binB } = await fixture();
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await beginAsManager(first);
      expect((await move(first, binA, b, a)).moved).toBe(true); // A → B, not committed

      await beginAsManager(second);
      const backend = await pid(second);
      const moving = move(second, binB, a, a); // B → A: would lock B before A without the order
      await waitUntilBlocked(backend);
      await first.query("commit");
      expect((await moving).moved).toBe(true);
      await second.query("commit");
      expect([await intakeOf(binA), await intakeOf(binB)]).toEqual([b, a]);
      const { rows } = await pool.query<{ n: number }>(
        "select count(*)::int as n from public.intake_history where org_id = $1",
        [org.id],
      );
      expect(rows[0]!.n).toBe(4);
    } finally {
      await release(first, second);
    }
  });

  it("PK-race a move waiting on a send re-checks under its locks: the target is now in blast", async () => {
    const { a, b, binA } = await fixture();
    // B at 50 lb, within: its send goes through.
    await pool.query("update public.vessel set weight_lb = 50 where intake_id = $1", [b]);
    const sender = await pool.connect();
    const mover = await pool.connect();
    try {
      await beginAsManager(sender);
      expect((await send(sender, b)).ok).toBe(true); // not committed

      await beginAsManager(mover);
      const backend = await pid(mover);
      const moving = mover
        .query("savepoint m")
        .then(() => move(mover, binA, b, a))
        .catch((e: Error) => e);
      await waitUntilBlocked(backend);
      await sender.query("commit");
      const outcome = await moving;
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe(
        "INT-0002 is in the blast freezer; pull it back to reconcile first",
      );
      await mover.query("rollback to savepoint m");
      await mover.query("commit");
      expect(await intakeOf(binA)).toBe(a);
    } finally {
      await release(sender, mover);
    }
  });
});
