import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  anonClient,
  createOrg,
  createUser,
  dropOrg,
  localSupabase,
  serviceRoleClient,
  type TestOrg,
  type TestUser,
} from "./testing/local-supabase";

describe("WP20 public status and transactional email", () => {
  let a: TestOrg, b: TestOrg, manager: TestUser, staff: TestUser, pool: pg.Pool;
  let customer: string, intake: string;
  const lookup = (slug = a.slug, phone = "(907) 555-1234") =>
    anonClient().rpc("customer_status", { p_slug: slug, p_phone: phone });
  beforeAll(async () => {
    a = await createOrg();
    b = await createOrg();
    manager = await createUser(a, "manager");
    staff = await createUser(a, "staff");
    pool = new pg.Pool({ connectionString: localSupabase().DB_URL });
    await pool.query(
      `update public.org set settings = settings || '{"pickup_hours":"Mon–Sat 9–5","rates_notice":"Final services determine charges"}' where id = $1`,
      [a.id],
    );
    for (const org of [a, b]) {
      const c = await pool.query(
        `insert into public.customer(org_id,name,phone,email) values($1,'Private Name','+19075551234','customer@example.test') returning id`,
        [org.id],
      );
      const i = await pool.query(
        `insert into public.intake(org_id,number,customer_id,state,estimated_pickup_at) values($1,$2,$3,'holding','2026-11-01T12:00:00Z') returning id`,
        [org.id, org === a ? "INT-0001" : "INT-9999", c.rows[0].id],
      );
      await pool.query(
        `insert into public.charge(org_id,number,customer_id,kind,source_type,source_id,qty,unit,unit_price) values($1,'CHG-0001',$2,'processing','intake',$3,2,'lb',10)`,
        [org.id, c.rows[0].id, i.rows[0].id],
      );
      if (org === a) {
        customer = c.rows[0].id;
        intake = i.rows[0].id;
      }
    }
  }, 60000);
  beforeEach(async () => {
    await pool.query("delete from public.status_lookup_limit where org_id = any($1)", [
      [a.id, b.id],
    ]);
  });
  afterAll(async () => {
    await pool?.end();
    if (a) await dropOrg(a);
    if (b) await dropOrg(b);
  });

  it("WP20 anonymous projection has no cross-org leakage, names, weights or unit prices", async () => {
    const { data, error } = await lookup();
    expect(error).toBeNull();
    expect(data).toEqual({
      org_name: a.slug,
      timezone: "UTC",
      pickup_hours: "Mon–Sat 9–5",
      rates_notice: "Final services determine charges",
      intakes: [
        {
          number: "INT-0001",
          state: "holding",
          estimated_pickup_at: "2026-11-01T12:00:00+00:00",
          amount_due: 20,
        },
      ],
    });
    expect(JSON.stringify(data)).not.toContain("INT-9999");
    const privateRead = await anonClient().from("customer").select("*");
    expect(privateRead.data ?? []).toEqual([]);
  });
  it("WP20 full phone is required; formatting normalizes; drafts and terminal intakes stay private", async () => {
    expect((await lookup(a.slug, "1234")).data).toEqual({ error: "invalid_phone" });
    expect((await lookup(a.slug, "+1 907 555 1234")).data).toMatchObject({
      intakes: [{ number: "INT-0001" }],
    });
    expect((await lookup(a.slug, "9075558888")).data).toMatchObject({ intakes: [] });
    for (const [index, state] of ["draft", "done", "cancelled"].entries()) {
      await pool.query(
        `insert into public.intake(org_id,number,customer_id,state) values($1,$2,$3,$4::public.intake_state)`,
        [a.id, `INT-900${index}`, customer, state],
      );
    }
    expect((await lookup()).data).toMatchObject({ intakes: [{ number: "INT-0001" }] });
  });
  it("WP20 atomic per-org rate limit counts concurrent misses and leaves another org available", async () => {
    await pool.query(
      "insert into public.status_lookup_limit values($1,date_trunc('minute',clock_timestamp()),59)",
      [a.id],
    );
    const results = await Promise.all([lookup(), lookup()]);
    expect(
      results.filter((r) => JSON.stringify(r.data) === '{"error":"rate_limited"}'),
    ).toHaveLength(1);
    expect((await lookup(b.slug)).data).toHaveProperty("intakes");
    await pool.query(
      "update public.status_lookup_limit set window_at = now() - interval '2 minutes' where org_id = $1",
      [a.id],
    );
    expect((await lookup()).data).toHaveProperty("intakes");
  });
  it("WP20 disabled and inactive orgs expose no status", async () => {
    await pool.query("update public.org set is_active = false where id = $1", [b.id]);
    expect((await lookup(b.slug)).data).toEqual({ error: "unavailable" });
    await pool.query(
      `update public.org set is_active = true, settings = settings || '{"status_page_enabled":false}' where id = $1`,
      [b.id],
    );
    expect((await lookup(b.slug)).data).toEqual({ error: "unavailable" });
    await pool.query(
      `update public.org set settings = settings || '{"status_page_enabled":true}' where id = $1`,
      [b.id],
    );
  });
  it("WP20 confirmation queues once and first stored email survives repeated state changes without duplicates", async () => {
    const confirmation = await pool.query(
      "select * from public.customer_email where org_id=$1 and kind='intake_confirmation'",
      [a.id],
    );
    expect(confirmation.rows).toHaveLength(1);
    // A dedicated connection is needed for the test-only forced transition setting.
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      for (const state of ["stored", "blast_freezer", "stored"]) {
        await connection.query("select set_config('app.forced_transition',$1,true)", [
          `intake:${intake}:${state}`,
        ]);
        await connection.query(
          "update public.intake set state=$1::public.intake_state where id=$2",
          [state, intake],
        );
      }
      await connection.query("commit");
    } finally {
      connection.release();
    }
    const ready = await pool.query(
      "select * from public.customer_email where org_id=$1 and kind='ready_for_pickup'",
      [a.id],
    );
    expect(ready.rows).toHaveLength(1);
  });
  it("WP20 manager ready trigger is idempotent and rejects staff and other org intake", async () => {
    const args = { p_client_action_id: randomUUID(), p_intake_id: intake };
    expect((await staff.client.rpc("customer_notify_ready", args)).error).not.toBeNull();
    expect((await manager.client.rpc("customer_notify_ready", args)).data).toEqual({
      queued: true,
    });
    expect((await manager.client.rpc("customer_notify_ready", args)).data).toEqual({
      queued: true,
    });
    const jobs = await pool.query("select * from public.customer_email where event_key=$1", [
      `manager:${args.p_client_action_id}`,
    ]);
    expect(jobs.rows).toHaveLength(1);
    const other = await pool.query("select id from public.intake where org_id=$1 limit 1", [b.id]);
    expect(
      (
        await manager.client.rpc("customer_notify_ready", {
          p_client_action_id: randomUUID(),
          p_intake_id: other.rows[0].id,
        })
      ).error,
    ).not.toBeNull();
  });
  it("WP20 shipped email includes tracking and dispatcher claims are exclusive and private", async () => {
    await pool.query(
      `insert into public.shipment(org_id,number,customer_id,state,tracking_number) values($1,'SHP-0001',$2,'shipped','TRACK-123')`,
      [a.id, customer],
    );
    const jobs = await pool.query(
      "select * from public.customer_email where org_id=$1 and kind='shipped'",
      [a.id],
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0].tracking).toBe("TRACK-123");
    expect((await anonClient().rpc("customer_email_claim")).error).not.toBeNull();
    const [first, second] = await Promise.all([
      serviceRoleClient().rpc("customer_email_claim"),
      serviceRoleClient().rpc("customer_email_claim"),
    ]);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    const ids = [...(first.data ?? []), ...(second.data ?? [])].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(jobs.rows[0].id);
  });
  it("WP20 retry window is bounded and staff cannot read delivery payloads", async () => {
    await pool.query(
      `update public.customer_email set lease_until=now()-interval '1 minute',
      first_attempt_at=now()-interval '24 hours' where org_id=$1`,
      [a.id],
    );
    const result = await serviceRoleClient().rpc("customer_email_claim");
    expect(result.error).toBeNull();
    expect(result.data?.filter((j) => j.org_id === a.id)).toEqual([]);
    expect(
      (await staff.client.from("customer_email").select("delivery_payload")).error,
    ).not.toBeNull();
    const { rows } = await pool.query("select settings from public.org where id=$1", [a.id]);
    const settings = {
      ...rows[0].settings,
      pickup_hours: "10–6",
      rates_notice: "Quoted at intake",
    };
    const updated = await manager.client.rpc("admin_update_org", {
      p_client_action_id: randomUUID(),
      p_name: a.slug,
      p_timezone: "UTC",
      p_settings: settings,
    });
    expect(updated.error).toBeNull();
    expect((await lookup()).data).toMatchObject({
      pickup_hours: "10–6",
      rates_notice: "Quoted at intake",
    });
  });
  it("WP20 public and receipt estimates share overrides, custom days and tenant guards", async () => {
    const { rows } = await pool.query(
      `insert into public.intake(org_id,number,customer_id,state,intake_at)
      values($1,'INT-8000',$2,'holding','2026-10-31T23:00:00Z') returning id`,
      [a.id, customer],
    );
    const id = rows[0].id as string;
    await pool.query(
      `update public.org set settings=settings || '{"estimated_pickup_days":5}' where id=$1`,
      [a.id],
    );
    for (const [override, expected] of [
      [null, "2026-11-05T23:00:00Z"],
      ["2026-11-09T02:00:00Z", "2026-11-09T02:00:00Z"],
    ]) {
      await pool.query("update public.intake set estimated_pickup_at=$1 where id=$2", [
        override,
        id,
      ]);
      const receipt = await staff.client.rpc("intake_pickup_estimate", { p_intake_id: id });
      expect(receipt.error).toBeNull();
      const result = await lookup();
      expect(result.error).toBeNull();
      const publicDate = (
        result.data as { intakes: { number: string; estimated_pickup_at: string }[] }
      ).intakes.find((i) => i.number === "INT-8000")?.estimated_pickup_at;
      expect(publicDate).toBe(receipt.data);
      expect(new Date(receipt.data!).toISOString()).toBe(new Date(expected!).toISOString());
    }
    expect(
      (await anonClient().rpc("intake_pickup_estimate", { p_intake_id: id })).error,
    ).not.toBeNull();
    const other = await pool.query("select id from public.intake where org_id=$1 limit 1", [b.id]);
    const foreign = await staff.client.rpc("intake_pickup_estimate", {
      p_intake_id: other.rows[0].id,
    });
    expect(foreign.error).toBeNull();
    expect(foreign.data).toBeNull();
  });
  it("WP20 blank rates notice continues to follow later receipt footer edits", async () => {
    for (const footer of ["Original footer", "Edited footer"]) {
      await pool.query(
        `update public.org set settings=settings || jsonb_build_object('rates_notice','','receipt_footer',$2::text) where id=$1`,
        [a.id, footer],
      );
      expect((await lookup()).data).toMatchObject({ rates_notice: footer });
    }
  });
});
