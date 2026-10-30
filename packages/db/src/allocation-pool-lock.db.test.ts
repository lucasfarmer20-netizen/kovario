// #102: allocation pooling serialises with bin moves and pull backs (I15/I17). A save that pools an
// intake takes its reconcile:<intake_id> advisory lock (sorted ids) after the session row, as
// reconcile, move bin and pull back take it, and reads the intake's state under it. Whichever runs
// second waits on that lock (asserted: the waiter is blocked on an advisory lock, not an intake
// row), then a move or pull back is refused, or the save pools the intake back at reconcile
// (DECISION-32: an intake not yet in blast stays poolable). The release paths (billing lock →
// sessions → vessels → intakes, I16) take no reconcile lock; racing them against a pooling save
// never deadlocks. #112: a save that pools an intake reprices the other priced sessions sharing it
// after it key-shares the intake, so a release of one of those sessions that holds it while it
// waits for the intake used to deadlock with the save; the release paths now take the billing lock
// first, so the two serialise on it. #113: a save reads its intakes' states under that billing lock,
// which a release holds when it closes an intake (I10): a save racing a close waits on it, then
// refuses the done intake, or the release waits and its close gate sees the save's planned box.
// The interleavings are forced: the second transaction is let go only once it blocks on a lock.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encode, NEW_ORG_TAG_DIGITS, normalizeTagCode } from "../../rules/src/index.ts";
import { createOrg, dropOrg, localSupabase, type TestOrg } from "./testing/local-supabase";

let pool: pg.Pool;
const orgs: TestOrg[] = [];

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: localSupabase().DB_URL, max: 4 });
});

afterAll(async () => {
  for (const org of orgs) await dropOrg(org);
  await pool?.end();
});

async function newOrg(): Promise<TestOrg> {
  const org = await createOrg();
  orgs.push(org);
  return org;
}

async function insertId(sql: string, args: unknown[]): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(sql, args);
  return rows[0]!.id;
}

/** Two intakes at reconcile, opened at rollstock A then B (one hold group), each expecting 50 lb,
 * with one exchange bin each (A 20 lb, B 30 lb). `aState` moves A on (blast_freezer for a pull
 * back). Each case has its own org. */
async function fixture(aState: "reconcile" | "blast_freezer" = "reconcile") {
  const org = await newOrg();
  const site = await insertId(
    "insert into public.site (org_id, name) values ($1, 'Line') returning id",
    [org.id],
  );
  const customer = await insertId(
    "insert into public.customer (org_id, name) values ($1, 'Race') returning id",
    [org.id],
  );
  for (const sql of [
    `insert into public.species (org_id, code, name, "group") values ($1, 'salmon', 'Salmon', 'salmon')`,
    "insert into public.incoming_condition (org_id, code, name) values ($1, 'whole', 'Whole')",
    "insert into public.processing_method (org_id, code, name) values ($1, 'fillets', 'Fillets')",
  ])
    await pool.query(sql, [org.id]);
  const ids: string[] = [];
  const bins: string[] = [];
  for (const [n, lb] of [
    [1, 20],
    [2, 30],
  ] as const) {
    const id = await insertId(
      `insert into public.intake (org_id, number, customer_id, site_id, tote_count)
       values ($1, $2, $3, $4, 1) returning id`,
      [org.id, `INT-000${n}`, customer, site],
    );
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
    bins.push(
      await insertId(
        `insert into public.vessel (org_id, intake_id, is_exchange, weight_lb) values ($1, $2, true, $3) returning id`,
        [org.id, id, lb],
      ),
    );
    ids.push(id);
  }
  if (aState !== "reconcile")
    await pool.query("update public.intake set state = $2 where id = $1", [ids[0], aState]);
  return { org, a: ids[0]!, b: ids[1]!, binA: bins[0]! };
}

async function begin(c: pg.PoolClient, org: TestOrg) {
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

async function call<T>(c: pg.PoolClient, sql: string, args: unknown[]): Promise<T> {
  const { rows } = await c.query(`select ${sql} as r`, [crypto.randomUUID(), ...args]);
  return rows[0].r as T;
}

/** Saves an allocation session pooling `intakeIds` (a new one unless `sessionId`). */
const savePooling = (c: pg.PoolClient, intakeIds: string[], sessionId?: string) =>
  call<{ session_id: string }>(c, "public.save_allocation_session($1, $2::jsonb)", [
    JSON.stringify({ session_id: sessionId, intake_ids: intakeIds }),
  ]);

const pullBack = (c: pg.PoolClient, intakeId: string) =>
  call<{ ok: boolean }>(c, "public.intake_pull_back($1, $2, 'Wrong bin')", [intakeId]);

const move = (c: pg.PoolClient, vesselId: string, to: string, center: string) =>
  call<{ moved: boolean }>(c, "public.variance_move_vessel($1, $2, $3, $4)", [
    vesselId,
    to,
    center,
  ]);

/** Runs `fn` behind a savepoint, so a refusal leaves the transaction usable; resolves to the
 * error instead of rejecting. */
function attempt<T>(c: pg.PoolClient, fn: () => Promise<T>): Promise<T | Error> {
  return c
    .query("savepoint s")
    .then(fn)
    .catch(async (e: Error) => {
      await c.query("rollback to savepoint s");
      return e;
    });
}

async function pid(c: pg.PoolClient): Promise<number> {
  const { rows } = await c.query<{ pid: number }>("select pg_backend_pid() as pid");
  return rows[0]!.pid;
}

/** Resolves to the lock `backend` is blocked on (pg_stat_activity.wait_event: advisory,
 * transactionid, tuple, …) once it waits on one. */
async function blockedOn(backend: number): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await pool.query<{ wait_event_type: string | null; wait_event: string }>(
      "select wait_event_type, wait_event from pg_stat_activity where pid = $1",
      [backend],
    );
    if (rows[0]?.wait_event_type === "Lock") return rows[0].wait_event;
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

async function scalar<T>(sql: string, args: unknown[]): Promise<T> {
  const { rows } = await pool.query(`select ${sql} as v`, args);
  return rows[0].v as T;
}

const state = (intakeId: string) =>
  scalar<string>("(select state::text from public.intake where id = $1)", [intakeId]);
const pooling = (intakeId: string) =>
  scalar<number>("(select count(*)::int from app.pooling_sessions($1))", [intakeId]);
const intakeOf = (vesselId: string) =>
  scalar<string>("(select intake_id from public.vessel where id = $1)", [vesselId]);

describe("Allocation pooling serialises with a pull back (I15/I17, #102)", () => {
  it("PK-race pooling first: the pull back waits on the reconcile lock, then is refused", async () => {
    const { org, a } = await fixture("blast_freezer");
    const saver = await pool.connect();
    const puller = await pool.connect();
    try {
      await begin(saver, org);
      await savePooling(saver, [a]); // not committed

      await begin(puller, org);
      const backend = await pid(puller);
      const pulling = attempt(puller, () => pullBack(puller, a));
      expect(await blockedOn(backend)).toBe("advisory");
      await saver.query("commit");
      const outcome = await pulling;
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe(
        "This order is in a counter allocation; it cannot be pulled back",
      );
      await puller.query("commit");
      expect([await state(a), await pooling(a)]).toEqual(["blast_freezer", 1]);
    } finally {
      await release(saver, puller);
    }
  });

  it("PK-race pull back first: the pooling save waits on the reconcile lock, then pools the intake back at reconcile", async () => {
    const { org, a } = await fixture("blast_freezer");
    const puller = await pool.connect();
    const saver = await pool.connect();
    try {
      await begin(puller, org);
      expect((await pullBack(puller, a)).ok).toBe(true); // not committed

      await begin(saver, org);
      const backend = await pid(saver);
      const saving = savePooling(saver, [a]);
      expect(await blockedOn(backend)).toBe("advisory");
      await puller.query("commit");
      expect((await saving).session_id).toBeTruthy();
      await saver.query("commit");
      expect([await state(a), await pooling(a)]).toEqual(["reconcile", 1]);
    } finally {
      await release(puller, saver);
    }
  });
});

describe("Allocation pooling serialises with a bin move (I15/I17, #102)", () => {
  it("PK-race pooling first: the move waits on the reconcile lock, then is refused", async () => {
    const { org, a, b, binA } = await fixture();
    const saver = await pool.connect();
    const mover = await pool.connect();
    try {
      await begin(saver, org);
      await savePooling(saver, [a]); // not committed

      await begin(mover, org);
      const backend = await pid(mover);
      const moving = attempt(mover, () => move(mover, binA, b, a));
      expect(await blockedOn(backend)).toBe("advisory");
      await saver.query("commit");
      const outcome = await moving;
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe(
        "INT-0001 is in a counter allocation; its baskets cannot move",
      );
      await mover.query("commit");
      expect([await intakeOf(binA), await pooling(a)]).toEqual([a, 1]);
    } finally {
      await release(saver, mover);
    }
  });

  it("PK-race move first: the pooling save waits on the reconcile lock, then pools the intakes as moved", async () => {
    const { org, a, b, binA } = await fixture();
    const mover = await pool.connect();
    const saver = await pool.connect();
    try {
      await begin(mover, org);
      expect((await move(mover, binA, b, a)).moved).toBe(true); // not committed

      await begin(saver, org);
      const backend = await pid(saver);
      // B before A in the payload: the save still locks in sorted id order.
      const saving = savePooling(saver, [b, a]);
      expect(await blockedOn(backend)).toBe("advisory");
      await mover.query("commit");
      expect((await saving).session_id).toBeTruthy();
      await saver.query("commit");
      expect([await intakeOf(binA), await pooling(a), await pooling(b)]).toEqual([b, 1, 1]);
    } finally {
      await release(mover, saver);
    }
  });
});

/** An intake in blast with two tagged 10 lb baskets, pooled by a session: a draft one (a save
 * reprices nothing), or a priced one split evenly with one planned will-call box, for a party
 * Complete. */
async function releaseFixture(state: "draft" | "priced") {
  const org = await newOrg();
  const customer = await insertId(
    "insert into public.customer (org_id, name) values ($1, 'Party') returning id",
    [org.id],
  );
  const intake = await insertId(
    `insert into public.intake (org_id, number, customer_id, state)
     values ($1, 'INT-0001', $2, 'blast_freezer') returning id`,
    [org.id, customer],
  );
  const vessels: string[] = [];
  const tags: string[] = [];
  for (const i of [1, 2]) {
    const code = normalizeTagCode(String(i), NEW_ORG_TAG_DIGITS)!;
    const tag = await insertId(
      "insert into public.asset_tag (org_id, code, qr) values ($1, $2, $3) returning id",
      [org.id, code, encode("TAG", { orgSlug: org.slug, code }, { tagDigits: NEW_ORG_TAG_DIGITS })],
    );
    const vessel = await insertId(
      `insert into public.vessel (org_id, intake_id, asset_tag_id, weight_lb)
       values ($1, $2, $3, 10) returning id`,
      [org.id, intake, tag],
    );
    await pool.query(
      "update public.asset_tag set state = 'in_use', current_vessel_id = $1 where id = $2",
      [vessel, tag],
    );
    vessels.push(vessel);
    tags.push(code);
  }
  const session = await insertId(
    `insert into public.allocation_session (org_id, number, party_customer_id, state, split_method)
     values ($1, 'ALC-0001', $2, $3, 'even') returning id`,
    [org.id, customer, state],
  );
  await pool.query(
    "insert into public.allocation_intake (org_id, session_id, intake_id) values ($1, $2, $3)",
    [org.id, session, intake],
  );
  if (state === "draft") return { org, intake, session, box: "", vessels, tags };
  const settlement = await insertId(
    `insert into public.settlement (org_id, number, session_id, angler_name)
     values ($1, 'STL-0001', $2, 'Ann') returning id`,
    [org.id, session],
  );
  const box = await insertId(
    `insert into public.box_plan (org_id, number, settlement_id, session_id, method)
     values ($1, 'BOX-0001', $2, $3, 'willcall') returning id`,
    [org.id, settlement, session],
  );
  return { org, intake, session, box, vessels, tags };
}

const byTag = (c: pg.PoolClient, tag: string) =>
  call<{ ok: boolean; noop: boolean }>(c, "public.release_by_tag($1, $2, 0, 'forgot to tick')", [
    tag,
  ]);

const complete = (c: pg.PoolClient, session: string, box: string, vessel: string) =>
  call<{ noop: boolean }>(c, "public.release_party($1, $2, $3, $4)", [
    session,
    [box],
    JSON.stringify([{ vessel_id: vessel, lbs_left: 0, measure: 10 }]),
  ]);

const vesselState = (vesselId: string) =>
  scalar<string>("(select lifecycle_state::text from public.vessel where id = $1)", [vesselId]);

describe("A pooling save never deadlocks with the release paths (I16)", () => {
  it("I16 Release-by-Tag first, then a save of the session pooling the basket's intake: the save waits, then both apply", async () => {
    const { org, intake, session, vessels, tags } = await releaseFixture("draft");
    const releaser = await pool.connect();
    const saver = await pool.connect();
    try {
      await begin(releaser, org);
      expect((await byTag(releaser, tags[0]!)).noop).toBe(false); // sessions → vessel → intake

      await begin(saver, org);
      const backend = await pid(saver);
      const saving = savePooling(saver, [intake], session); // session → reconcile lock
      await blockedOn(backend);
      await releaser.query("commit");
      expect((await saving).session_id).toBe(session);
      await saver.query("commit");
      expect([await vesselState(vessels[0]!), await pooling(intake)]).toEqual(["emptied", 1]);
    } finally {
      await release(releaser, saver);
    }
  });

  it("I16 a save of the session first, then Release-by-Tag of its basket: the release waits, then both apply", async () => {
    const { org, intake, session, vessels, tags } = await releaseFixture("draft");
    const saver = await pool.connect();
    const releaser = await pool.connect();
    try {
      await begin(saver, org);
      await savePooling(saver, [intake], session); // holds the session and the reconcile lock

      await begin(releaser, org);
      const backend = await pid(releaser);
      const releasing = byTag(releaser, tags[0]!);
      await blockedOn(backend);
      await saver.query("commit");
      expect((await releasing).noop).toBe(false);
      await releaser.query("commit");
      expect(await vesselState(vessels[0]!)).toBe("emptied");
    } finally {
      await release(saver, releaser);
    }
  });

  it("I16 a party Complete first, then a new session pooling the same intake: the save waits, then both apply", async () => {
    const { org, intake, session, box, vessels } = await releaseFixture("priced");
    const releaser = await pool.connect();
    const saver = await pool.connect();
    try {
      await begin(releaser, org);
      expect((await complete(releaser, session, box, vessels[0]!)).noop).toBe(false);

      await begin(saver, org);
      const backend = await pid(saver);
      const saving = savePooling(saver, [intake]); // billing → new session → reconcile lock → intake
      await blockedOn(backend);
      await releaser.query("commit");
      expect((await saving).session_id).not.toBe(session);
      await saver.query("commit");
      expect([await vesselState(vessels[0]!), await pooling(intake)]).toEqual(["emptied", 2]);
    } finally {
      await release(releaser, saver);
    }
  });

  it("I16 a new session pooling the intake first, then a party Complete: the Complete waits, then both apply", async () => {
    const { org, intake, session, box, vessels } = await releaseFixture("priced");
    const saver = await pool.connect();
    const releaser = await pool.connect();
    try {
      await begin(saver, org);
      await savePooling(saver, [intake]); // and reprices the priced session sharing the intake

      await begin(releaser, org);
      const backend = await pid(releaser);
      const completing = complete(releaser, session, box, vessels[0]!);
      await blockedOn(backend);
      await saver.query("commit");
      expect((await completing).noop).toBe(false);
      await releaser.query("commit");
      expect([await vesselState(vessels[0]!), await pooling(intake)]).toEqual(["emptied", 2]);
    } finally {
      await release(saver, releaser);
    }
  });
});

type ReleasePath = "Complete" | "Release-by-Tag" | "Restore";
const releasePaths: ReleasePath[] = ["Complete", "Release-by-Tag", "Restore"];

const restore = (c: pg.PoolClient, vesselId: string) =>
  call<{ restored: boolean }>(c, "public.restore_vessel($1, $2, 'Counted wrong')", [vesselId]);

/** releaseFixture("priced") (ALC-0001) plus a draft ALC-0002 with one angler that pools nothing
 * yet: saving it to pool the intake reprices ALC-0001, which shares the intake (#112). For
 * Restore, the first basket is released by tag beforehand (attributed to ALC-0001). */
async function sharingFixture(path: ReleasePath) {
  const f = await releaseFixture("priced");
  const other = await insertId(
    `insert into public.allocation_session (org_id, number, party_customer_id, state, split_method)
     select org_id, 'ALC-0002', party_customer_id, 'draft', 'even'
     from public.allocation_session where id = $1 returning id`,
    [f.session],
  );
  const angler = await insertId(
    `insert into public.settlement (org_id, number, session_id, angler_name)
     values ($1, 'STL-0002', $2, 'Bo') returning id`,
    [f.org.id, other],
  );
  if (path === "Restore") {
    const c = await pool.connect();
    try {
      await begin(c, f.org);
      expect((await byTag(c, f.tags[0]!)).noop).toBe(false);
      await c.query("commit");
    } finally {
      c.release();
    }
  }
  return { ...f, other, angler };
}

type SharingFixture = Awaited<ReturnType<typeof sharingFixture>>;

/** Saves ALC-0002 pooling the intake (keeping its angler): key-shares the intake, then reprices
 * ALC-0001. */
const saveSharing = (c: pg.PoolClient, f: SharingFixture) =>
  call<{ session_id: string }>(c, "public.save_allocation_session($1, $2::jsonb)", [
    JSON.stringify({
      session_id: f.other,
      intake_ids: [f.intake],
      settlements: [{ id: f.angler, angler_name: "Bo" }],
    }),
  ]);

/** Releases (or restores) the first basket by `path`: each locks ALC-0001, then the basket, and
 * the intake last. */
function releaseBy(c: pg.PoolClient, f: SharingFixture, path: ReleasePath): Promise<unknown> {
  if (path === "Complete") return complete(c, f.session, f.box, f.vessels[0]!);
  if (path === "Release-by-Tag") return byTag(c, f.tags[0]!);
  return restore(c, f.vessels[0]!);
}

/** Takes `lockSql`'s row lock on a third connection; the returned function lets it go. */
async function gate(lockSql: string, id: string): Promise<() => Promise<void>> {
  const c = await pool.connect();
  await c.query("begin");
  await c.query(lockSql, [id]);
  return async () => {
    await c.query("rollback");
    c.release();
  };
}

const failures = (...outcomes: unknown[]) =>
  outcomes.filter((o): o is Error => o instanceof Error).map((e) => e.message);

describe("A save repricing a session never deadlocks with a release of it (I16, #112)", () => {
  it.each(releasePaths)(
    "I16 %s first, held after locking ALC-0001; a save pooling the intake reprices ALC-0001 inside that window: no deadlock, both apply",
    async (path) => {
      const f = await sharingFixture(path);
      // The release locks ALC-0001, then waits here for the basket.
      const letGo = await gate(
        "select 1 from public.vessel where id = $1 for update",
        f.vessels[0]!,
      );
      const releaser = await pool.connect();
      const saver = await pool.connect();
      try {
        await begin(releaser, f.org);
        const releaserPid = await pid(releaser);
        const releasing = attempt(releaser, () => releaseBy(releaser, f, path));
        await blockedOn(releaserPid);

        await begin(saver, f.org);
        const saverPid = await pid(saver);
        const saving = attempt(saver, () => saveSharing(saver, f));
        await blockedOn(saverPid);
        await letGo(); // the release goes on to lock the intake the save key-shares
        const released = await releasing;
        await releaser.query("commit");
        const saved = await saving;
        await saver.query("commit");

        expect(failures(released, saved)).toEqual([]);
        expect([await vesselState(f.vessels[0]!), await pooling(f.intake)]).toEqual([
          path === "Restore" ? "occupied" : "emptied",
          2,
        ]);
      } finally {
        await release(releaser, saver);
      }
    },
  );

  it.each(releasePaths)(
    "I16 a save pooling the intake first, held after key-sharing it; %s locks ALC-0001 and then the intake inside that window, before the save reprices ALC-0001: no deadlock, both apply",
    async (path) => {
      const f = await sharingFixture(path);
      // The save pools the intake, then waits here for its angler, before it reprices.
      const letGo = await gate(
        "select 1 from public.settlement where id = $1 for update",
        f.angler,
      );
      const saver = await pool.connect();
      const releaser = await pool.connect();
      try {
        await begin(saver, f.org);
        const saverPid = await pid(saver);
        const saving = attempt(saver, () => saveSharing(saver, f));
        await blockedOn(saverPid);

        await begin(releaser, f.org);
        const releaserPid = await pid(releaser);
        const releasing = attempt(releaser, () => releaseBy(releaser, f, path));
        await blockedOn(releaserPid);
        await letGo(); // the save goes on to reprice ALC-0001
        const saved = await saving;
        await saver.query("commit");
        const released = await releasing;
        await releaser.query("commit");

        expect(failures(saved, released)).toEqual([]);
        expect([await vesselState(f.vessels[0]!), await pooling(f.intake)]).toEqual([
          path === "Restore" ? "occupied" : "emptied",
          2,
        ]);
      } finally {
        await release(saver, releaser);
      }
    },
  );
});

type ClosingPath = "Complete" | "Release-by-Tag";
const closingPaths: ClosingPath[] = ["Complete", "Release-by-Tag"];

/** An intake whose second basket is already released by tag, so releasing the first by `path`
 * closes it to done (I10): Complete finalises ALC-0001's only box with it (priced); Release-by-Tag
 * releases it under a draft ALC-0001 with no box plans. A box size lets a save plan a box. */
async function closingFixture(path: ClosingPath) {
  const f = await releaseFixture(path === "Complete" ? "priced" : "draft");
  const c = await pool.connect();
  try {
    await begin(c, f.org);
    expect((await byTag(c, f.tags[1]!)).noop).toBe(false);
    await c.query("commit");
  } finally {
    c.release();
  }
  const boxSize = await insertId(
    "insert into public.box_size (org_id, name, max_lb) values ($1, 'Medium', 50) returning id",
    [f.org.id],
  );
  return { ...f, boxSize };
}

type ClosingFixture = Awaited<ReturnType<typeof closingFixture>>;

/** Releases the intake's last basket by `path`; the close gate then closes the intake. */
function closeBy(c: pg.PoolClient, f: ClosingFixture, path: ClosingPath): Promise<unknown> {
  if (path === "Complete") return complete(c, f.session, f.box, f.vessels[0]!);
  return byTag(c, f.tags[0]!);
}

/** Saves a new session pooling the intake, with one angler and one planned will-call box. */
const savePlanning = (c: pg.PoolClient, f: ClosingFixture) =>
  call<{ session_id: string }>(c, "public.save_allocation_session($1, $2::jsonb)", [
    JSON.stringify({
      intake_ids: [f.intake],
      settlements: [
        {
          angler_name: "Cy",
          boxes: [{ method: "willcall", box_size_id: f.boxSize, weight_lb: 10 }],
        },
      ],
    }),
  ]);

describe("A pooling save never pools an intake a release is closing (I10, #113)", () => {
  it.each(closingPaths)(
    "I10 %s closing the intake first: the save waits on the billing lock, then refuses the done intake",
    async (path) => {
      const f = await closingFixture(path);
      const releaser = await pool.connect();
      const saver = await pool.connect();
      try {
        await begin(releaser, f.org);
        await closeBy(releaser, f, path); // closes the intake; not committed
        expect(await state(f.intake)).toBe("blast_freezer");

        await begin(saver, f.org);
        const backend = await pid(saver);
        const saving = attempt(saver, () => savePlanning(saver, f));
        expect(await blockedOn(backend)).toBe("advisory");
        await releaser.query("commit");
        const outcome = await saving;
        expect(outcome).toBeInstanceOf(Error);
        expect((outcome as Error).message).toBe(
          "cannot pool INT-0001 (done): only saved, open intakes can be allocated",
        );
        await saver.query("commit");
        expect([await state(f.intake), await pooling(f.intake)]).toEqual(["done", 1]);
      } finally {
        await release(releaser, saver);
      }
    },
  );

  it.each(closingPaths)(
    "I10 a save pooling the intake first: %s waits on the billing lock, then sees the save's planned box and leaves the intake open",
    async (path) => {
      const f = await closingFixture(path);
      const saver = await pool.connect();
      const releaser = await pool.connect();
      try {
        await begin(saver, f.org);
        await savePlanning(saver, f); // not committed

        await begin(releaser, f.org);
        const backend = await pid(releaser);
        const releasing = attempt(releaser, () => closeBy(releaser, f, path));
        expect(await blockedOn(backend)).toBe("advisory");
        await saver.query("commit");
        expect(failures(await releasing)).toEqual([]);
        await releaser.query("commit");
        expect([
          await vesselState(f.vessels[0]!),
          await state(f.intake),
          await pooling(f.intake),
        ]).toEqual(["emptied", "blast_freezer", 2]);
      } finally {
        await release(saver, releaser);
      }
    },
  );
});
