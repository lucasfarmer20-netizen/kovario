import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOrg,
  createUser,
  dropOrg,
  localSupabase,
  type TestOrg,
  type TestUser,
} from "./testing/local-supabase";

// WP-06 acceptance: search returns within 150 ms on 50k seeded customers, measured end to
// end through PostgREST as a staff session (the path the intake dropdown takes).
const CUSTOMERS = 50_000;
const BUDGET_MS = 150;
const RUNS = 5;

const QUERIES = [
  "907",
  "(907) 555-",
  "907555",
  "+1907",
  "+1 (907) 555-1234",
  "555-1234",
  "1234",
  "Smith",
  "ann",
];

describe("search_customers on 50k customers", () => {
  let org: TestOrg;
  let staff: TestUser;
  let pool: pg.Pool;

  beforeAll(async () => {
    org = await createOrg();
    staff = await createUser(org, "staff");
    pool = new pg.Pool({ connectionString: localSupabase().DB_URL, max: 1 });
    // Mostly one area code (the worst case for a 3-digit query), some 555 exchanges, a
    // spread of surnames and visit dates.
    await pool.query(
      `insert into public.customer (org_id, name, phone, last_visit_at)
       select $1,
              (array['Ann','Bob','Cal','Dee','Eli','Fay','Gus','Hal'])[1 + i % 8] || ' ' ||
                (array['Smith','Jones','Nguyen','Olsen','Petrov','Kowalski','Ivanov','Hansen','Larsen','Berg'])[1 + (i / 8) % 10]
                || ' ' || i,
              '+1' || (case when i % 10 < 8 then '907' else (array['208','360','541','206'])[1 + i % 4] end)
                || (case when i % 7 = 0 then '555' else lpad((200 + i % 800)::text, 3, '0') end)
                || lpad((i % 10000)::text, 4, '0'),
              now() - make_interval(days => i % 900)
       from generate_series(1, $2::int) i`,
      [org.id, CUSTOMERS],
    );
    // Statistics only; no VACUUM, so the GIN indexes see the rows exactly as inserted.
    await pool.query("analyze public.customer");
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (org) await dropOrg(org);
  });

  it(`answers every query within ${BUDGET_MS} ms`, async () => {
    const search = (q: string) =>
      staff.client.rpc("search_customers", { p_org_id: org.id, p_q: q });

    // Warm the connection, PostgREST schema cache and the plan.
    for (const q of QUERIES) await search(q);

    const slowest: Record<string, number> = {};
    for (const q of QUERIES) {
      const times: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const start = performance.now();
        const { data, error } = await search(q);
        times.push(performance.now() - start);
        expect(error).toBeNull();
        expect(data?.length).toBeGreaterThan(0);
      }
      // Median of the runs: one GC pause or scheduler hiccup on a shared CI box is not a
      // regression; a slow plan makes every run slow.
      slowest[q] = Math.round([...times].sort((a, b) => a - b)[Math.floor(RUNS / 2)] ?? Infinity);
    }
    expect(Object.entries(slowest).filter(([, ms]) => ms >= BUDGET_MS)).toEqual([]);
  }, 120_000);

  it("ranks the exact number first among thousands of matches", async () => {
    const { data, error } = await staff.client.rpc("search_customers", {
      p_org_id: org.id,
      p_q: "(907) 555-0007",
    });
    expect(error).toBeNull();
    expect(data?.[0]?.phone).toBe("+19075550007");
  });
});
