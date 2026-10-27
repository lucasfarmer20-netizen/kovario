import { createClient } from "@supabase/supabase-js";
import type { Database, Json } from "db";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { deliver, fileLog, jobSchema, retry, sessionStorage } from "./index";

const env = z
  .object({
    SUPABASE_URL: z.url(),
    SUPABASE_ANON_KEY: z.string().min(1),
    PRINT_AGENT_HOME: z.string().optional(),
  })
  .parse(process.env);
const home = env.PRINT_AGENT_HOME ?? join(homedir(), ".filletry-print-agent");
const log = (event: Parameters<typeof fileLog>[1], id?: string) =>
  fileLog(join(home, "agent.log"), event, id);
const client = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: {
    storage: sessionStorage(join(home, "session.json")),
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});
const pairIndex = process.argv.indexOf("--pair");
if (pairIndex >= 0) {
  // Pass the one-time code in PRINT_AGENT_PAIRING_CODE rather than shell history.
  const code = process.env.PRINT_AGENT_PAIRING_CODE;
  if (!code) throw new Error("Set PRINT_AGENT_PAIRING_CODE");
  const { data, error } = await client.functions.invoke("print-agent-pair", { body: { code } });
  const paired = z
    .object({ session: z.object({ access_token: z.string(), refresh_token: z.string() }) })
    .safeParse(data);
  if (error || !paired.success) throw new Error("Pairing failed; request a fresh code");
  const result = await client.auth.setSession(paired.data.session);
  if (result.error) throw new Error("Pairing session failed");
  delete process.env.PRINT_AGENT_PAIRING_CODE;
}
const { data: auth, error } = await client.auth.getClaims();
if (error || auth?.claims.app_role !== "agent" || typeof auth.claims.org_id !== "string")
  throw new Error("Pair this agent first");
const orgId = auth.claims.org_id;
async function rpc(
  name: "claim_print_job" | "print_agent_heartbeat" | "finish_print_job",
  args: { p_client_action_id: string; p_job_id?: string; p_error?: string },
): Promise<Json> {
  const { data, error } = await client.rpc(name, args as never);
  if (error) throw new Error("Queue operation failed");
  return data;
}
let busy = false;
let stopped = false;
async function drain() {
  if (busy || stopped) return;
  busy = true;
  try {
    while (!stopped) {
      const actionId = randomUUID();
      const raw = await retry(() => rpc("claim_print_job", { p_client_action_id: actionId }));
      if (raw === null) break;
      const job = jobSchema.parse(raw);
      let failed = false;
      try {
        await retry(() => deliver(job));
        await log("delivered", job.id);
      } catch {
        failed = true;
        await log("delivery_failed", job.id);
      }
      // A transient acknowledgement failure must NEVER resend bytes to the printer.
      const finishId = randomUUID();
      await retry(() =>
        rpc("finish_print_job", {
          p_client_action_id: finishId,
          p_job_id: job.id,
          ...(failed ? { p_error: "delivery_failed" } : {}),
        }),
      );
    }
  } catch {
    await log("queue_failed");
  } finally {
    busy = false;
  }
}
async function heartbeat() {
  const id = randomUUID();
  try {
    await retry(() => rpc("print_agent_heartbeat", { p_client_action_id: id }));
  } catch {
    await log("heartbeat_failed");
  }
}
const channel = client
  .channel("print-queue")
  .on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: "print_job", filter: `org_id=eq.${orgId}` },
    () => {
      void drain();
    },
  )
  .subscribe((status) => {
    if (status === "SUBSCRIBED") void drain();
  });
const poll = setInterval(() => {
  void drain();
}, 5000);
const pulse = setInterval(() => {
  void heartbeat();
}, 30_000);
async function stop() {
  if (stopped) return;
  stopped = true;
  clearInterval(poll);
  clearInterval(pulse);
  await client.removeChannel(channel);
  client.auth.stopAutoRefresh();
  await log("stopped");
}
process.once("SIGINT", () => {
  void stop();
});
process.once("SIGTERM", () => {
  void stop();
});
await log("started");
await heartbeat();
await drain();
