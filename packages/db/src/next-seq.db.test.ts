import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, dropOrg, localSupabase, type TestOrg } from "./testing/local-supabase";

describe("next_seq under concurrency", () => {
  let org: TestOrg;
  let pool: pg.Pool;

  beforeAll(async () => {
    org = await createOrg();
    pool = new pg.Pool({ connectionString: localSupabase().DB_URL, max: 10 });
  });

  afterAll(async () => {
    await pool.end();
    await dropOrg(org);
  });

  it("10 concurrent calls on separate connections yield 10 distinct, gap-free numbers", async () => {
    // Hold 10 connections open, then fire all calls at once so they contend on the
    // counter row (the first ones also race on the initial insert).
    const conns = await Promise.all(Array.from({ length: 10 }, () => pool.connect()));
    try {
      const results = await Promise.all(
        conns.map((c) =>
          c
            .query<{ n: string }>("select app.next_seq($1, 'intake') as n", [org.id])
            .then((r) => r.rows[0]?.n),
        ),
      );
      expect(new Set(results).size).toBe(10);
      expect([...results].sort()).toEqual(
        Array.from({ length: 10 }, (_, i) => `INT-${String(i + 1).padStart(4, "0")}`),
      );
    } finally {
      for (const c of conns) c.release();
    }
  });
});
