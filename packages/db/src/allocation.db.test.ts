// WP-14 counter allocation: price_session lands on exactly what packages/rules
// priceSettlements computes for the same session, and app.split_amount (generated from
// allocation.ts) agrees with splitAmount — shares and rejections — over a grid of inputs.
// Behaviour (m2m pooling, shared intakes, heavy check, receipts, rollup) is in
// supabase/tests/14_allocation.test.sql.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { priceSettlements, splitAmount } from "../../rules/src/index.ts";
import type { Json } from "./types";
import {
  createOrg,
  createUser,
  dropOrg,
  localSupabase,
  serviceRoleClient,
  type TestOrg,
  type TestUser,
} from "./testing/local-supabase";

type Session = {
  session_id: string;
  pool: { total: number };
  settlements: {
    number: string;
    weight_total_lb: number;
    processing_share: number;
    box_fee_total: number;
    freight_total: number;
    amount_total: number;
  }[];
};

describe("price_session prices what priceSettlements computes", { timeout: 60_000 }, () => {
  let org: TestOrg;
  let staff: TestUser;
  const ids = { customer: "", intakes: [] as string[], small: "", big: "" };

  beforeAll(async () => {
    org = await createOrg();
    const admin = serviceRoleClient();
    const ok = <T>(r: { data: T; error: { message: string } | null }) => {
      if (r.error) throw new Error(r.error.message);
      return r.data;
    };
    ok(
      await admin.from("species").insert([
        { org_id: org.id, code: "salmon_kings", name: "Kings", group: "salmon" },
        { org_id: org.id, code: "whitefish_lingcod", name: "Lingcod", group: "whitefish" },
      ]),
    );
    ok(
      await admin.from("processing_method").insert([
        { org_id: org.id, code: "smoking", name: "Smoking", kind: "service" },
        { org_id: org.id, code: "portions", name: "Portions", kind: "service" },
      ]),
    );
    const customer = ok(
      await admin
        .from("customer")
        .insert({ org_id: org.id, name: "Party", phone: "+19075551499" })
        .select("id")
        .single(),
    );
    ids.customer = customer.id;
    const intakes = ok(
      await admin
        .from("intake")
        .insert(
          ["INT-0001", "INT-0002"].map((number) => ({
            org_id: org.id,
            number,
            customer_id: customer.id,
            tote_count: 1,
          })),
        )
        .select("id, number"),
    );
    ids.intakes = intakes.sort((a, b) => a.number.localeCompare(b.number)).map((r) => r.id);
    ok(await admin.from("intake").update({ state: "holding" }).in("id", ids.intakes));
    // Pool 287.44: 33.33 lb @ 2.85 = 94.99; ribbing 12.4 @ 0.45 = 5.58; 61.07 @ 3.06 = 186.87 (rounded).
    ok(
      await admin.from("charge").insert(
        [
          [ids.intakes[0]!, "processing", 33.33, 2.85],
          [ids.intakes[0]!, "ribbing", 12.4, 0.45],
          [ids.intakes[1]!, "processing", 61.07, 3.06],
        ].map(([source_id, kind, qty, unit_price], i) => ({
          org_id: org.id,
          number: `CHG-${String(i + 1).padStart(4, "0")}`,
          customer_id: customer.id,
          kind: kind as "processing" | "ribbing",
          source_type: "intake" as const,
          source_id: source_id as string,
          qty: qty as number,
          unit: "lb",
          unit_price: unit_price as number,
        })),
      ),
    );
    const sizes = ok(
      await admin
        .from("box_size")
        .insert([
          { org_id: org.id, name: "Small", max_lb: 30, fee: 9.75 },
          { org_id: org.id, name: "Big", max_lb: 80, fee: 14.2 },
        ])
        .select("id, name"),
    );
    ids.small = sizes.find((s) => s.name === "Small")!.id;
    ids.big = sizes.find((s) => s.name === "Big")!.id;
    staff = await createUser(org, "staff");
  });

  afterAll(async () => {
    if (org) await dropOrg(org);
  });

  const anglers = () => [
    {
      angler_name: "Ann",
      species: [
        { species_code: "salmon_kings", method_code: "smoking", lb: 11.37 },
        { species_code: "whitefish_lingcod", method_code: "portions", lb: 4.2 },
      ],
      boxes: [
        { method: "ship", box_size_id: ids.big, weight_lb: 72.5, heavy_allowed: true },
        { method: "air", box_size_id: ids.small, weight_lb: 18, heavy_allowed: false },
      ],
    },
    {
      angler_name: "Bo",
      species: [{ species_code: "salmon_kings", method_code: "smoking", lb: 7.01 }],
      boxes: [{ method: "willcall", box_size_id: ids.small, weight_lb: 7, heavy_allowed: false }],
    },
    {
      angler_name: "Cy",
      species: [{ species_code: "whitefish_lingcod", method_code: "portions", lb: 23.9 }],
      boxes: [],
    },
  ];

  for (const method of ["weight", "even"] as const) {
    it(`${method} split: stored settlements equal priceSettlements; shares sum to the pool`, async () => {
      const saved = await staff.client.rpc("save_allocation_session", {
        p_client_action_id: crypto.randomUUID(),
        p_payload: {
          split_method: method,
          intake_ids: ids.intakes,
          settlements: anglers(),
        } as Json,
      });
      if (saved.error) throw saved.error;
      const sessionId = (saved.data as unknown as Session).session_id;
      const priced = await staff.client.rpc("price_session", {
        p_client_action_id: crypto.randomUUID(),
        p_session_id: sessionId,
      });
      if (priced.error) throw priced.error;
      const session = priced.data as unknown as Session;
      // Only the first session bills the shared intakes; cancel so the next test's session does.
      const cancelled = await staff.client.rpc("cancel_allocation_session", {
        p_client_action_id: crypto.randomUUID(),
        p_session_id: sessionId,
      });
      if (cancelled.error) throw cancelled.error;

      const fees = { [ids.small]: 9.75, [ids.big]: 14.2 };
      const expected = priceSettlements({
        pooledProcessing: Number(session.pool.total),
        method,
        anglers: anglers().map((a) => ({
          speciesLb: a.species.map((s) => s.lb),
          boxFees: a.boxes.map((b) => fees[b.box_size_id]!),
          freight: 0,
        })),
      });
      expect(Number(session.pool.total)).toBe(287.44);
      expect(
        session.settlements.map((s) => ({
          weightTotalLb: Number(s.weight_total_lb),
          processingShare: Number(s.processing_share),
          boxFeeTotal: Number(s.box_fee_total),
          freightTotal: Number(s.freight_total),
          amountTotal: Number(s.amount_total),
        })),
      ).toEqual(expected);
      const sum = session.settlements.reduce((c, s) => c + Math.round(s.processing_share * 100), 0);
      expect(sum).toBe(28744);
    });
  }
});

describe("app.split_amount is splitAmount", () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: localSupabase().DB_URL, max: 2 });
  });
  afterAll(async () => {
    await pool.end();
  });

  it("agrees on a seeded grid of totals and weights (including rejections)", async () => {
    // Deterministic LCG so a failure reproduces.
    let seed = 1414;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const cases: { total: number; weights: number[] }[] = [
      { total: 0.05, weights: [1, 1, 1] },
      { total: 100.01, weights: [10, 20, 30] },
      { total: 10, weights: [0, 0] },
      { total: 1, weights: [] },
      { total: 1.005, weights: [1] },
      { total: 5, weights: [-1, 2] },
    ];
    for (let i = 0; i < 150; i++) {
      const n = 1 + rand(7);
      cases.push({
        total: rand(5_000_000) / 100,
        weights: Array.from({ length: n }, () => (rand(4) === 0 ? 0 : rand(100_000) / 100)),
      });
    }
    const ts = cases.map((c) => {
      try {
        return splitAmount(c.total, c.weights);
      } catch {
        return "error";
      }
    });
    const sql = await Promise.all(
      cases.map((c) =>
        pool
          .query<{ s: string[] }>(
            "select app.split_amount($1::numeric, $2::numeric[])::text[] as s",
            [c.total, c.weights],
          )
          .then((r) => r.rows[0]!.s.map(Number))
          .catch(() => "error" as const),
      ),
    );
    expect(sql).toEqual(ts);
    expect(ts.filter((t) => t === "error").length).toBeGreaterThanOrEqual(4);
  });
});
