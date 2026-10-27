// WP-15 release: the generated SQL rules agree with packages/rules release.ts, and the
// two-transaction cases of the release spec (docs/10-LESSONS-FROM-CSP.md §2) hold under real
// concurrency — P18 (two fresh wizards, same party), a party Complete racing Release-by-Tag
// on the same basket (lock envelope sessions → vessels → intakes), and two sibling-vessel
// releases of one intake (the I10 gate's intake lock + re-read). Interleavings are forced
// deterministically: the first transaction holds its locks until the second is seen blocked.
// Every other path P1–P24 is in supabase/tests/15_release.test.sql.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  encode,
  releaseLineIssue,
  shipmentBuyGate,
  vesselReleaseAction,
} from "../../rules/src/index.ts";
import { createOrg, dropOrg, localSupabase, type TestOrg } from "./testing/local-supabase";

let pool: pg.Pool;
let org: TestOrg;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: localSupabase().DB_URL, max: 6 });
  org = await createOrg();
}, 60_000);

afterAll(async () => {
  if (org) await dropOrg(org);
  await pool?.end();
});

describe("generated release SQL ≡ release.ts", () => {
  it("I5 line rule over a grid", async () => {
    const lbs = [null, 0, 0.01, 0.29, 5, 9.99, 10, 10.01, -1, 0.004, 9.996, 0.001];
    for (const ticked of [true, false]) {
      for (const left of lbs) {
        const { rows } = await pool.query<{ issue: string | null; action: string | null }>(
          `select app.release_line_issue($1, $2, 10) as issue,
                  case when app.release_line_issue($1, $2, 10) is null
                       then app.vessel_release_action($1, $2, 10) end as action`,
          [ticked, left],
        );
        const issue = releaseLineIssue(ticked, left, 10);
        expect(rows[0]!.issue, `ticked=${ticked} left=${left}`).toBe(issue);
        expect(rows[0]!.action).toBe(issue ? null : vesselReleaseAction(ticked, left, 10));
      }
    }
  });

  it("I13 buy gate over a grid", async () => {
    const today = "2026-07-20";
    for (const shipDate of [null, "2026-07-19", "2026-07-21", "2026-07-22", "2026-08-30"]) {
      for (const forceBuyHeld of [false, true]) {
        for (const service of [null, "usps"]) {
          for (const blockers of [[], ["bad_address", "bad_address"]]) {
            for (const labelBought of [false, true]) {
              const { rows } = await pool.query<{ g: Record<string, unknown> }>(
                "select app.shipment_buy_gate($1, $2, 1, $3, $4, $5, $6) as g",
                [shipDate, today, forceBuyHeld, service, blockers, labelBought],
              );
              const ts = shipmentBuyGate({
                shipDate,
                today,
                buyWindowDays: 1,
                forceBuyHeld,
                service,
                blockers,
                labelBought,
              });
              expect(rows[0]!.g).toEqual({
                held: ts.held,
                blockers: ts.blockers,
                can_buy: ts.canBuy,
                can_reprint: ts.canReprint,
              });
            }
          }
        }
      }
    }
  });
});

// Concurrency ---------------------------------------------------------------------------------

type Party = { session: string; box: string; vessels: string[]; intake: string; tags: string[] };

async function insertId(c: pg.PoolClient, sql: string, args: unknown[]): Promise<string> {
  const { rows } = await c.query<{ id: string }>(sql, args);
  return rows[0]!.id;
}
let seq = 0;

/** A priced party: one stored intake with `n` tagged vessels (10 lb each) and one box. */
async function party(n: number, pooled = true): Promise<Party> {
  const k = ++seq;
  const c = await pool.connect();
  try {
    await c.query("begin");
    const customer = await insertId(
      c,
      "insert into public.customer (org_id, name) values ($1, 'Race party') returning id",
      [org.id],
    );
    const intake = await insertId(
      c,
      `insert into public.intake (org_id, number, customer_id, state)
       values ($1, $2, $3, 'stored') returning id`,
      [org.id, `INT-${String(k).padStart(4, "0")}`, customer],
    );
    const vessels: string[] = [];
    const tags: string[] = [];
    for (let i = 1; i <= n; i++) {
      const code = String(k * 10 + i).padStart(3, "0");
      const tag = await insertId(
        c,
        "insert into public.asset_tag (org_id, code, qr) values ($1, $2, $3) returning id",
        [org.id, code, encode("TAG", { orgSlug: org.slug, code })],
      );
      const vessel = await insertId(
        c,
        `insert into public.vessel (org_id, intake_id, asset_tag_id, weight_lb)
         values ($1, $2, $3, 10) returning id`,
        [org.id, intake, tag],
      );
      await c.query(
        "update public.asset_tag set state = 'in_use', current_vessel_id = $1 where id = $2",
        [vessel, tag],
      );
      vessels.push(vessel);
      tags.push(code);
    }
    let session = "";
    let box = "";
    if (pooled) {
      session = await insertId(
        c,
        `insert into public.allocation_session (org_id, number, party_customer_id, state)
         values ($1, $2, $3, 'priced') returning id`,
        [org.id, `ALC-${String(k).padStart(4, "0")}`, customer],
      );
      await c.query(
        "insert into public.allocation_intake (org_id, session_id, intake_id) values ($1, $2, $3)",
        [org.id, session, intake],
      );
      const settlement = await insertId(
        c,
        `insert into public.settlement (org_id, number, session_id, angler_name)
         values ($1, $2, $3, 'Ann') returning id`,
        [org.id, `STL-${String(k).padStart(4, "0")}`, session],
      );
      box = await insertId(
        c,
        `insert into public.box_plan (org_id, number, settlement_id, session_id, method)
         values ($1, $2, $3, $4, 'willcall') returning id`,
        [org.id, `BOX-${String(k).padStart(4, "0")}`, settlement, session],
      );
    }
    await c.query("commit");
    return { session, box, vessels, intake, tags };
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

async function begin(c: pg.PoolClient, role: "staff" | "manager") {
  await c.query("begin");
  await c.query("set local role authenticated");
  await c.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({
      sub: crypto.randomUUID(),
      role: "authenticated",
      org_id: org.id,
      app_role: role,
    }),
  ]);
}

type Reply = { noop: boolean; message?: string; action?: string };

async function call(c: pg.PoolClient, sql: string, args: unknown[]): Promise<Reply> {
  const { rows } = await c.query(`select ${sql} as r`, args);
  return rows[0].r as Reply;
}

const complete = (c: pg.PoolClient, p: Party) =>
  call(c, "public.release_party($1, $2, $3, $4)", [
    crypto.randomUUID(),
    p.session,
    [p.box],
    JSON.stringify(p.vessels.map((vessel_id) => ({ vessel_id, lbs_left: 0, measure: 10 }))),
  ]);

const byTag = (c: pg.PoolClient, tag: string) =>
  call(c, "public.release_by_tag($1, $2, 0, 'forgot to tick')", [crypto.randomUUID(), tag]);

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

/**
 * Runs `first` in t1 (left open), starts `second` in t2 and waits until it blocks on t1's
 * locks, then commits t1 and t2. Returns both replies (or SQLSTATEs).
 */
async function race(
  first: (c: pg.PoolClient) => Promise<Reply>,
  second: (c: pg.PoolClient) => Promise<Reply>,
  roles: ["staff" | "manager", "staff" | "manager"],
) {
  const t1 = await pool.connect();
  const t2 = await pool.connect();
  try {
    await begin(t1, roles[0]);
    const r1 = await first(t1);
    const pid = (await t2.query("select pg_backend_pid() as p")).rows[0].p as number;
    await begin(t2, roles[1]);
    const pending = second(t2).catch((e: { code?: string; message: string }) => ({
      error: e.code ?? e.message,
    }));
    await waitUntilBlocked(pid);
    await t1.query("commit");
    const r2 = await pending;
    await t2.query("error" in r2 ? "rollback" : "commit");
    return [r1, r2] as const;
  } finally {
    for (const c of [t1, t2]) {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
  }
}

async function counts(p: Party) {
  const { rows } = await pool.query<{ kind: string; n: number }>(
    `select event_kind::text as kind, count(*)::int as n from public.release_audit
     where intake_id = $1 group by 1`,
    [p.intake],
  );
  return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
}

describe("concurrent releases", { timeout: 60_000 }, () => {
  it("P18 two fresh wizards, same party: first applies, second no-ops (D0/I16)", async () => {
    const p = await party(2);
    const [r1, r2] = await race(
      (c) => complete(c, p),
      (c) => complete(c, p),
      ["staff", "staff"],
    );
    expect(r1.noop).toBe(false);
    expect(r2).toMatchObject({ noop: true });
    expect(await counts(p)).toEqual({ moved: 2, finalized: 1 }); // no double release
    const { rows } = await pool.query("select state from public.intake where id = $1", [p.intake]);
    expect(rows[0].state).toBe("done");
  });

  it("I16 lock envelope: a party Complete and Release-by-Tag on one basket never double-release", async () => {
    const p = await party(1);
    const [r1, r2] = await race(
      (c) => complete(c, p),
      (c) => byTag(c, p.tags[0]!),
      ["staff", "manager"],
    );
    expect(r1.noop).toBe(false);
    expect(r2).toMatchObject({ noop: true }); // re-read under lock: already released
    expect(await counts(p)).toEqual({ moved: 1, finalized: 1 });
  });

  it("I16 lock envelope: Release-by-Tag first, then the party Complete drops the stale tote", async () => {
    const p = await party(1);
    const [r1, r2] = await race(
      (c) => byTag(c, p.tags[0]!),
      (c) => complete(c, p),
      ["manager", "staff"],
    );
    expect(r1).toMatchObject({ noop: false, action: "full_pull" });
    // The box still finalises: the tag release wrote a moved row for this party (I8).
    expect(r2).toMatchObject({ noop: false });
    expect(await counts(p)).toEqual({ moved: 1, finalized: 1 });
  });

  it("I10 two sibling-vessel releases of one unpooled intake: the second closes it", async () => {
    const p = await party(2, false);
    const [r1, r2] = await race(
      (c) => byTag(c, p.tags[0]!),
      (c) => byTag(c, p.tags[1]!),
      ["manager", "manager"],
    );
    expect([r1, r2]).toMatchObject([{ noop: false }, { noop: false }]);
    const { rows } = await pool.query("select state from public.intake where id = $1", [p.intake]);
    expect(rows[0].state).toBe("done"); // not stranded open
  });
});
