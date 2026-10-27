// WP-09 storage box labels reach a printer through the real WP-08 agent contract: the station
// renders each label with packages/labels storageBoxLabel from confirm_storage_intake's label
// data, queue_storage_labels stores that ZPL, and the agent's claim_print_job → jobSchema →
// deliver path sends exactly those bytes (QR FL:SBOX:<number>:<box_no>) to the printer.
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deliver, jobSchema } from "../../../agent/print-agent/src/index.ts";
import { storageBoxLabel } from "../../labels/src/zpl.ts";
import { encode } from "../../rules/src/index.ts";
import {
  createOrg,
  createUser,
  dropOrg,
  localSupabase,
  type TestOrg,
  type TestUser,
} from "./testing/local-supabase";

type LabelData = {
  storage_number: string;
  customer: string;
  date: string;
  boxes: { box_id: string; box_no: number }[];
};

async function as(
  client: pg.PoolClient,
  claims: Record<string, string>,
  sql: string,
  params: unknown[],
) {
  await client.query("begin");
  await client.query(
    "select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)",
    [JSON.stringify({ role: "authenticated", ...claims })],
  );
  try {
    const result = await client.query(sql, params);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

describe("storage box labels through the print agent", { timeout: 60_000 }, () => {
  let org: TestOrg;
  let agentUser: TestUser;
  let pool: pg.Pool;
  let agentId: string;
  let customerId: string;
  let received = "";
  const printer = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      received += chunk;
    });
  });

  beforeAll(async () => {
    org = await createOrg();
    agentUser = await createUser(null);
    pool = new pg.Pool({ connectionString: localSupabase().DB_URL, max: 2 });
    await new Promise<void>((resolve) => printer.listen(0, "127.0.0.1", resolve));
    const address = printer.address();
    if (!address || typeof address === "string") throw new Error("No port");

    const site = await pool.query<{ id: string }>(
      "insert into public.site (org_id, name, is_default) values ($1, 'Freezer', true) returning id",
      [org.id],
    );
    const agent = await pool.query<{ id: string }>(
      "insert into public.print_agent (org_id, name, site_id, auth_user_id) values ($1, 'Freezer PC', $2, $3) returning id",
      [org.id, site.rows[0]!.id, agentUser.id],
    );
    agentId = agent.rows[0]!.id;
    await pool.query(
      `insert into public.printer (org_id, name, site_id, kind, agent_id, address, is_default_for)
       values ($1, 'ZD421', $2, 'label_zpl', $3, $4, '{"storage_label": true}')`,
      [org.id, site.rows[0]!.id, agentId, `127.0.0.1:${address.port}`],
    );
    const customer = await pool.query<{ id: string }>(
      "insert into public.customer (org_id, name) values ($1, 'Label Customer') returning id",
      [org.id],
    );
    customerId = customer.rows[0]!.id;
  });

  afterAll(async () => {
    await pool.end();
    await new Promise<void>((resolve) => printer.close(() => resolve()));
    await dropOrg(org);
  });

  it("confirm → render → queue → claim → deliver sends each box's label with its SBOX QR", async () => {
    const c = await pool.connect();
    const staff = { sub: randomUUID(), org_id: org.id, app_role: "staff" };
    const agent = { sub: agentUser.id, org_id: org.id, app_role: "agent", agent_id: agentId };
    try {
      const confirmed = await as(c, staff, "select public.confirm_storage_intake($1, $2) as r", [
        randomUUID(),
        { customer_id: customerId, boxes: [{}, {}] },
      ]);
      const r = confirmed.rows[0].r as { storage_intake_id: string; labels: LabelData };
      expect(r.labels.customer).toBe("Label Customer");

      // What the station does (apps/web/components/storage/storage-labels.ts).
      const labels = r.labels.boxes.map((b) => ({
        box_id: b.box_id,
        zpl: storageBoxLabel({
          storageNumber: r.labels.storage_number,
          boxNo: b.box_no,
          customer: r.labels.customer,
          date: r.labels.date,
        }),
      }));
      const queued = await as(c, staff, "select public.queue_storage_labels($1, $2, $3) as r", [
        randomUUID(),
        r.storage_intake_id,
        JSON.stringify(labels),
      ]);
      expect(queued.rows[0].r).toMatchObject({ label_jobs_queued: 2, printer_missing: false });

      // Jobs of one queue call share created_at, so claim order between them is not fixed.
      const printed: string[] = [];
      for (let n = 0; n < labels.length; n++) {
        const claimed = await as(c, agent, "select public.claim_print_job($1) as r", [
          randomUUID(),
        ]);
        const job = jobSchema.parse(claimed.rows[0].r);
        received = "";
        await deliver(job);
        expect(received).toBe(job.payload);
        printed.push(received);
        await as(c, agent, "select public.finish_print_job($1, $2)", [randomUUID(), job.id]);
      }
      expect(printed.sort()).toEqual(labels.map((l) => l.zpl).sort());
      for (const b of r.labels.boxes) {
        expect(labels.find((l) => l.box_id === b.box_id)?.zpl).toContain(
          `^FDLA,${encode("SBOX", { storageNumber: r.labels.storage_number, boxNo: b.box_no })}^FS`,
        );
      }
      const done = await pool.query<{ n: string }>(
        "select count(*) as n from public.print_job where org_id = $1 and kind = 'storage_label' and state = 'done'",
        [org.id],
      );
      expect(done.rows[0]!.n).toBe("2");
    } finally {
      c.release();
    }
  });
});
