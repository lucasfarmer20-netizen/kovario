// WP-07 intake: the station's packages/rules output round-trips through save_intake — the
// database prices the drafts itself (app.price_per_lb, generated from pricing.ts) and must
// land on exactly the amounts the live price panel showed — and app.price_per_lb agrees with
// pricePerLb over a grid of inputs. Behaviour (lock, unlock/re-save, reprice, validation) is
// in supabase/tests/07_intake.test.sql.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildIntakeDraft,
  pricePerLb,
  referenceSeed,
  savePayload,
  type IntakeLine,
  type PriceInput,
} from "../../rules/src/index.ts";
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

const RATES: Record<string, number> = {
  fillets: 1.55,
  portions: 1.2,
  smoking: 2.85,
  ribbing_per_lb: 0.45,
  fast_pass_per_lb: 1.99,
};

const LINES: IntakeLine[] = [
  { species: "salmon_silvers", condition: "whole", method: "fresh", lb: 50.35, filletsPct: 65 },
  { species: "whitefish_halibut", condition: "filleted_ribs", method: "portions", lb: 30.2 },
  { species: "salmon_kings", condition: "hg", method: "smoking", lb: 12.75 },
  { species: "whitefish_rockfish", condition: "whole", method: "portions", lb: 8, skinOff: true },
];

type Context = {
  rates: Record<string, number>;
  lodge_cappable: Record<string, boolean>;
  customer: { is_lodge_guest: boolean; lodge_cap: number | null };
};

describe("save_intake prices what the station previewed", { timeout: 60_000 }, () => {
  let org: TestOrg;
  let staff: TestUser;
  const customers: Record<"plain" | "lodge", string> = { plain: "", lodge: "" };

  beforeAll(async () => {
    org = await createOrg();
    const admin = serviceRoleClient();
    const seeded = await admin.rpc("seed_org_reference", {
      p_org_id: org.id,
      p_reference: referenceSeed() as unknown as Json,
    });
    if (seeded.error) throw seeded.error;
    const cardId = (seeded.data as { rate_card_id: string }).rate_card_id;
    for (const [key, amount] of Object.entries(RATES)) {
      const { error } = await admin
        .from("rate_card_line")
        .update({ amount })
        .eq("rate_card_id", cardId)
        .eq("key", key);
      if (error) throw error;
    }
    // Smoking is not lodge-cappable in this org: the cap must skip it.
    await admin
      .from("processing_method")
      .update({ lodge_cappable: false })
      .eq("org_id", org.id)
      .eq("code", "smoking");
    const { data: lodge, error: lodgeError } = await admin
      .from("lodge")
      .insert({ org_id: org.id, name: "Kenai", pricing_cap: 1.4 })
      .select("id")
      .single();
    if (lodgeError) throw lodgeError;
    const { data: rows, error } = await admin
      .from("customer")
      .insert([
        {
          org_id: org.id,
          name: "Plain",
          phone: "+19075550101",
          is_lodge_guest: false,
          lodge_id: null,
        },
        {
          org_id: org.id,
          name: "Lodge",
          phone: "+19075550102",
          is_lodge_guest: true,
          lodge_id: lodge.id,
        },
      ])
      .select("id, name");
    if (error) throw error;
    customers.plain = rows.find((r) => r.name === "Plain")!.id;
    customers.lodge = rows.find((r) => r.name === "Lodge")!.id;
    staff = await createUser(org, "staff");
  });

  afterAll(async () => {
    if (org) await dropOrg(org);
  });

  for (const [who, fastPass] of [
    ["plain", false],
    ["plain", true],
    ["lodge", false],
    ["lodge", true],
  ] as const) {
    it(`${who}${fastPass ? " + Fast Pass" : ""}: stored charges equal buildIntakeDraft`, async () => {
      const customerId = customers[who];
      const ctx = await staff.client.rpc("intake_price_context", { p_customer_id: customerId });
      if (ctx.error) throw ctx.error;
      const c = ctx.data as unknown as Context;
      const draft = buildIntakeDraft(LINES, {
        rates: c.rates,
        fastPass,
        isLodgeGuest: c.customer.is_lodge_guest,
        lodgeCap: c.customer.lodge_cap,
        lodgeCappable: c.lodge_cappable,
      });
      expect(draft.missingRates).toEqual([]);

      const payload = savePayload({ customerId, toteCount: 3, dirtyFish: false, fastPass }, LINES);
      const saved = await staff.client.rpc("save_intake", {
        p_client_action_id: crypto.randomUUID(),
        p_payload: payload as unknown as Json,
      });
      if (saved.error) throw saved.error;
      const intakeId = (saved.data as { intake_id: string }).intake_id;

      const { data: charges, error } = await staff.client
        .from("charge")
        .select("kind, rate_key, qty, unit_price, amount")
        .eq("source_id", intakeId)
        .order("number");
      if (error) throw error;
      expect(charges.map((r) => [r.kind, r.rate_key, r.unit_price, r.amount])).toEqual(
        draft.charges.map((d) => [d.kind, d.rateKey, d.unitPrice, d.amount]),
      );

      const { data: intake } = await staff.client
        .from("intake")
        .select("total_incoming_lb, total_est_yield_lb, ribbing, locked, state")
        .eq("id", intakeId)
        .single();
      expect(intake).toEqual({
        total_incoming_lb: draft.totalLb,
        total_est_yield_lb: draft.totalEstYieldLb,
        ribbing: true,
        locked: true,
        state: "holding",
      });
    });
  }
});

describe("app.price_per_lb is pricePerLb", () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: localSupabase().DB_URL, max: 2 });
  });
  afterAll(async () => {
    await pool.end();
  });

  it("agrees on every combination of the grid (including which inputs are rejected)", async () => {
    const cases: PriceInput[] = [];
    for (const method of ["portions", "ribbing"] as const)
      for (const listPrice of [0, 1.25, 2.5])
        for (const fastPassRate of [null, 0, 1.75])
          for (const lodgeCap of [null, 1, 3])
            for (const isLodgeGuest of [false, true])
              for (const fastPass of [false, true])
                for (const lodgeCappable of [false, true])
                  cases.push({
                    method,
                    listPrice,
                    fastPassRate,
                    lodgeCap,
                    isLodgeGuest,
                    fastPass,
                    lodgeCappable,
                  });
    const ts = cases.map((c) => {
      try {
        return pricePerLb(c);
      } catch {
        return "error";
      }
    });
    const sql = await Promise.all(
      cases.map((c) =>
        pool
          .query<{ p: string }>("select app.price_per_lb($1, $2, $3, $4, $5, $6, $7) as p", [
            c.method,
            c.listPrice,
            c.fastPass,
            c.fastPassRate,
            c.isLodgeGuest,
            c.lodgeCap,
            c.lodgeCappable,
          ])
          .then((r) => Number(r.rows[0]!.p))
          .catch(() => "error" as const),
      ),
    );
    expect(sql).toEqual(ts);
    expect(ts).toContain("error"); // Fast Pass without a floor is rejected by both
  });
});
