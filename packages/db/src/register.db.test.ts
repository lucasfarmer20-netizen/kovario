// WP-16 register: app.tax_amount / app.tax_total (generated from packages/rules tax.ts) agree
// with computeTax over a grid; two Charges racing on one cart create ONE pending payment (the
// cart row lock + the unresolved-payment guard — never charge twice). Behaviour (load, hook,
// refunds, receipts) is in supabase/tests/16_register.test.sql; the route-handler flow with
// the fake provider is apps/web/lib/payments/service.db.test.ts.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeTax, type TaxMode } from "../../rules/src/index.ts";
import {
  createOrg,
  dropOrg,
  localSupabase,
  serviceRoleClient,
  type TestOrg,
} from "./testing/local-supabase";

describe("register tax: SQL ≡ rules", { timeout: 60_000 }, () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: localSupabase().DB_URL, max: 2 });
  });
  afterAll(async () => {
    await pool.end();
  });

  it("app.tax_amount / app.tax_total match computeTax on every grid point", async () => {
    const modes: TaxMode[] = ["exclusive", "inclusive", "none"];
    const rates = [0, 0.01, 0.0575, 0.06, 0.07125, 0.25, 1];
    const caps = [null, 0, 2, 30];
    const subtotals = [-20, 0, 0.01, 0.25, 0.83, 10.75, 19.99, 106, 499.99, 500, 1234.56, 99999.99];
    const cases = modes.flatMap((mode) =>
      rates.flatMap((rate) =>
        caps.flatMap((cap) => subtotals.map((subtotal) => ({ mode, rate, cap, subtotal }))),
      ),
    );
    const { rows } = await pool.query<{ i: number; tax: string; total: string }>(
      `select c.i, app.tax_amount(c.setting, c.subtotal)::text as tax, app.tax_total(c.setting, c.subtotal)::text as total
       from jsonb_to_recordset($1::jsonb) as c (i int, setting jsonb, subtotal numeric)`,
      [
        JSON.stringify(
          cases.map((c, i) => ({
            i,
            setting: { mode: c.mode, rate: c.rate, cap_amount: c.cap },
            subtotal: c.subtotal,
          })),
        ),
      ],
    );
    expect(rows).toHaveLength(cases.length);
    for (const row of rows) {
      const c = cases[row.i]!;
      const want = computeTax({ mode: c.mode, rate: c.rate, cap_amount: c.cap }, c.subtotal);
      expect([Number(row.tax), Number(row.total)], JSON.stringify(c)).toEqual([
        want.tax,
        want.total,
      ]);
    }
  });

  it("both reject what computeTax rejects", async () => {
    for (const setting of [{ rate: 1.5 }, { rate: -0.01 }, { rate: 0.06, cap_amount: -1 }]) {
      await expect(
        pool.query("select app.tax_amount($1::jsonb, 10)", [JSON.stringify(setting)]),
      ).rejects.toThrow();
      expect(() =>
        computeTax(
          { mode: "exclusive", rate: setting.rate, cap_amount: setting.cap_amount ?? null },
          10,
        ),
      ).toThrow();
    }
  });
});

describe("two Charges racing on one cart", { timeout: 60_000 }, () => {
  let org: TestOrg;
  let pool: pg.Pool;
  let orderId = "";
  let terminalId = "";

  async function begin(client: pg.PoolClient): Promise<void> {
    const claims = {
      sub: randomUUID(),
      role: "authenticated",
      org_id: org.id,
      app_role: "cashier",
    };
    await client.query("begin");
    await client.query(
      "select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)",
      [JSON.stringify(claims)],
    );
  }

  beforeAll(async () => {
    org = await createOrg();
    pool = new pg.Pool({ connectionString: localSupabase().DB_URL, max: 4 });
    const admin = serviceRoleClient();
    const { data: customer, error } = await admin
      .from("customer")
      .insert({ org_id: org.id, name: "Racing Rae", phone: "+19075551699" })
      .select("id")
      .single();
    if (error) throw error;
    const { error: chargeError } = await admin.from("charge").insert({
      org_id: org.id,
      number: "CHG-9101",
      customer_id: customer.id,
      kind: "adjustment",
      source_type: "manual",
      qty: 1,
      unit: "each",
      unit_price: 50,
    });
    if (chargeError) throw chargeError;
    const { data: terminal, error: terminalError } = await admin
      .from("payment_terminal")
      .insert({ org_id: org.id, name: "Dejavoo 1", provider: "dejavoo_spin" })
      .select("id")
      .single();
    if (terminalError) throw terminalError;
    terminalId = terminal.id;
    const c = await pool.connect();
    try {
      await begin(c);
      const { rows } = await c.query<{ r: { id: string } }>(
        "select public.register_load_outstanding($1, $2) as r",
        [`race-load-${randomUUID()}`, customer.id],
      );
      orderId = rows[0]!.r.id;
      await c.query("commit");
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    await pool.end();
    if (org) await dropOrg(org);
  });

  it("the second Charge waits on the cart lock, then is refused: one pending payment, never two", async () => {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await begin(a);
      await begin(b);
      const sql = "select public.payment_begin($1, $2, 50, $3) as r";
      await a.query(sql, [`race-a-${randomUUID()}`, orderId, terminalId]);
      const second = b.query(sql, [`race-b-${randomUUID()}`, orderId, terminalId]).then(
        () => "ok",
        (e: { code?: string }) => e.code ?? "error",
      );
      await a.query("commit");
      expect(await second).toBe("55000");
      await b.query("rollback");
      const { rows } = await pool.query<{ n: string }>(
        "select count(*) as n from public.payment where register_order_id = $1 and state = 'pending'",
        [orderId],
      );
      expect(Number(rows[0]!.n)).toBe(1);
    } finally {
      a.release();
      b.release();
    }
  });
});
