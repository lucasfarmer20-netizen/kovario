import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createOrg,
  createUser,
  dropOrg,
  serviceRoleClient,
  type TestOrg,
  type TestUser,
} from "./testing/local-supabase";
import { enqueuePrintJob } from "./print-jobs";
let org: TestOrg,
  other: TestOrg,
  manager: TestUser,
  agent: TestUser,
  agent2: TestUser,
  outsider: TestUser;
let agentId: string, agent2Id: string, printerId: string;
const admin = () => serviceRoleClient();
beforeAll(async () => {
  org = await createOrg();
  other = await createOrg();
  manager = await createUser(org, "manager");
  outsider = await createUser(other, "manager");
  agent = await createUser(null);
  agent2 = await createUser(null);
  for (const [u, set] of [
    [
      agent,
      (id: string) => {
        agentId = id;
      },
    ],
    [
      agent2,
      (id: string) => {
        agent2Id = id;
      },
    ],
  ] as const) {
    const { data, error } = await admin()
      .from("print_agent")
      .insert({ org_id: org.id, name: "LAN agent", auth_user_id: u.id })
      .select("id")
      .single();
    if (error) throw error;
    set(data.id);
    const refresh = await u.client.auth.refreshSession();
    if (refresh.error) throw refresh.error;
  }
  const { data, error } = await admin()
    .from("printer")
    .insert({
      org_id: org.id,
      name: "Zebra",
      kind: "label_zpl",
      agent_id: agentId,
      address: "127.0.0.1:9100",
    })
    .select("id")
    .single();
  if (error) throw error;
  printerId = data.id;
}, 60_000);
afterAll(async () => {
  await admin().from("print_job").delete().eq("org_id", org.id);
  await admin().from("printer").delete().eq("org_id", org.id);
  await dropOrg(org);
  await dropOrg(other);
  await admin().auth.admin.deleteUser(agent.id);
  await admin().auth.admin.deleteUser(agent2.id);
});
async function enqueue(id = randomUUID()) {
  return enqueuePrintJob(manager.client, id, {
    printerId,
    kind: "tote_tag",
    payloadType: "zpl",
    payload: "^XA^FDTEST^FS^XZ",
  });
}
it("enqueue is idempotent and validates tenant and payload kind", async () => {
  const id = randomUUID();
  expect(await enqueue(id)).toEqual(await enqueue(id));
  const count = await admin()
    .from("print_job")
    .select("id", { count: "exact" })
    .eq("org_id", org.id);
  expect(count.count).toBe(1);
  await expect(
    enqueuePrintJob(outsider.client, randomUUID(), {
      printerId,
      kind: "tote_tag",
      payloadType: "zpl",
      payload: "^XA^XZ",
    }),
  ).rejects.toThrow("Printer not configured");
  await expect(
    enqueuePrintJob(manager.client, randomUUID(), {
      printerId,
      kind: "receipt",
      payloadType: "pdf_url",
      payload: "https://example.invalid/receipt.pdf",
    }),
  ).rejects.toThrow("Printer payload mismatch");
  await admin().from("print_job").delete().eq("org_id", org.id);
});
it("SKIP LOCKED concurrent claims never claim the same job; replays restore claim", async () => {
  await enqueue();
  await enqueue();
  const [a, b] = await Promise.all([
    agent.client.rpc("claim_print_job", { p_client_action_id: randomUUID() }),
    agent.client.rpc("claim_print_job", { p_client_action_id: randomUUID() }),
  ]);
  expect(a.error).toBeNull();
  expect(b.error).toBeNull();
  const first = a.data as { id: string };
  const second = b.data as { id: string };
  expect(first.id).not.toBe(second.id);
  for (const j of [first, second]) {
    const id = randomUUID();
    const args = { p_client_action_id: id, p_job_id: j.id };
    expect((await agent.client.rpc("finish_print_job", args)).error).toBeNull();
    expect((await agent.client.rpc("finish_print_job", args)).error).toBeNull();
  }
  await enqueue();
  const id = randomUUID();
  const claim = await agent.client.rpc("claim_print_job", { p_client_action_id: id });
  expect((await agent.client.rpc("claim_print_job", { p_client_action_id: id })).data).toEqual(
    claim.data,
  );
  expect(
    (await agent.client.rpc("claim_print_job", { p_client_action_id: randomUUID() })).data,
  ).toBeNull();
});
it("agent cannot read customer data, another agent's printers or jobs, or enqueue", async () => {
  expect((await agent.client.from("org").select("id")).data).toEqual([]);
  expect((await agent.client.from("customer").select("id")).data).toEqual([]);
  expect((await agent.client.from("action_log").select("id")).data).toEqual([]);
  expect((await agent2.client.from("printer").select("id")).data).toEqual([]);
  expect((await agent2.client.from("print_job").select("id")).data).toEqual([]);
  expect(
    (await agent2.client.rpc("claim_print_job", { p_client_action_id: randomUUID() })).data,
  ).toBeNull();
  expect((await agent.client.from("print_agent").select("id")).data).toEqual([{ id: agentId }]);
  expect((await agent.client.from("print_agent").select("token_hash")).error).not.toBeNull();
  await expect(
    enqueuePrintJob(agent.client, randomUUID(), {
      printerId,
      kind: "tote_tag",
      payloadType: "zpl",
      payload: "^XA^XZ",
    }),
  ).rejects.toThrow();
  expect(
    (await agent.client.rpc("print_agent_heartbeat", { p_client_action_id: randomUUID() })).error,
  ).toBeNull();
  const heartbeat = await admin()
    .from("print_agent")
    .select("last_seen_at")
    .eq("id", agentId)
    .single();
  expect(heartbeat.data?.last_seen_at).not.toBeNull();
  expect(agent2Id).not.toBe(agentId);
});
it("one-time pairing is hashed, expiring and never recorded in action_log", async () => {
  const id = randomUUID();
  const args = { p_client_action_id: id, p_agent_id: agentId };
  const issued = await manager.client.rpc("admin_print_agent_pairing_code", args);
  expect(issued.error).toBeNull();
  const code = issued.data![0]!.code;
  expect((await manager.client.rpc("admin_print_agent_pairing_code", args)).data).toEqual(
    issued.data,
  );
  const row = await admin().from("print_agent").select("token_hash").eq("id", agentId).single();
  expect(row.data?.token_hash).not.toBe(code);
  const audit = await admin()
    .from("action_log")
    .select("result,input")
    .eq("client_action_id", id)
    .single();
  expect(JSON.stringify(audit.data)).not.toContain(code);
  expect(
    (await agent.client.rpc("print_agent_redeem_pairing", { p_code: code })).error,
  ).not.toBeNull();
  expect((await admin().rpc("print_agent_redeem_pairing", { p_code: code })).data).toHaveLength(1);
  expect((await admin().rpc("print_agent_redeem_pairing", { p_code: code })).data).toEqual([]);
});
