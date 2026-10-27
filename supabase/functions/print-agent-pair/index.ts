// One-time pairing for a plant LAN service. Never log session or underlying auth errors.
import { anonClient, json, preflight, randomSecret, serviceClient } from "../_shared/supabase.ts";

const AGENT_EMAIL_DOMAIN = "agents.filletry.internal";

type Redeemed = {
  agent_id: string;
  org_id: string;
  auth_user_id: string | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const body = await req.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!/^[A-Za-z0-9]{8}$/.test(code)) return json({ error: "invalid_code" }, 400);

  const admin = serviceClient();
  const { data: rows, error: redeemError } = await admin.rpc("print_agent_redeem_pairing", { p_code: code });
  const agent = (rows as Redeemed[] | null)?.[0];
  if (redeemError || !agent) return json({ error: "invalid_or_expired_code" }, 400);

  const email = `agent-${agent.agent_id}@${AGENT_EMAIL_DOMAIN}`;
  const password = randomSecret();

  let userId = agent.auth_user_id;
  if (userId) {
    const { error } = await admin.auth.admin.updateUserById(userId, { password });
    if (error) userId = null; // auth user was removed; create a fresh one below
  }
  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { kind: "agent", agent_id: agent.agent_id },
    });
    if (error || !data.user) {
      console.error("print-agent-pair: createUser failed");
      return json({ error: "pairing_failed" }, 500);
    }
    userId = data.user.id;
  }

  const { error: bindError } = await admin.rpc("print_agent_bind_auth_user", {
    p_agent_id: agent.agent_id,
    p_user_id: userId,
  });
  if (bindError) {
    console.error("print-agent-pair: bind failed");
    return json({ error: "pairing_failed" }, 500);
  }

  const { data: signIn, error: signInError } = await anonClient().auth.signInWithPassword({
    email,
    password,
  });
  if (signInError || !signIn.session) {
    console.error("print-agent-pair: sign-in failed");
    return json({ error: "pairing_failed" }, 500);
  }

  return json({
    session: {
      access_token: signIn.session.access_token,
      refresh_token: signIn.session.refresh_token,
    },
    agent: {
      id: agent.agent_id,
      org_id: agent.org_id,
    },
  });
});
