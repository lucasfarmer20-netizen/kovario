import { createClient } from "@supabase/supabase-js";
import type { Database } from "db";
import { tokensMatch, webhookToken } from "shipping";
import { supabaseEnv } from "@/lib/supabase/env";
import { applyTracking } from "@/lib/shipping/service";

// POST /api/shipping/webhook?org=<org id>&token=<org token>  (Shippo → Filletry, track_updated).
// docs/07 §4. Shippo does not sign webhooks, and each plant registers this URL in its own Shippo
// account, so the credential is per org: token = HMAC(SHIPPO_WEBHOOK_TOKEN, org id) (shown to the
// plant in Admin → Sites). The platform secret never leaves the server, and an org's token
// authenticates events for that org only — shipping_apply_tracking matches parcels in that org
// and nowhere else.
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.SHIPPO_WEBHOOK_TOKEN;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret || !serviceKey) return Response.json({ error: "not_configured" }, { status: 503 });
  const params = new URL(req.url).searchParams;
  const orgId = params.get("org") ?? "";
  if (!UUID.test(orgId) || !tokensMatch(params.get("token"), await webhookToken(secret, orgId))) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_payload" }, { status: 400 });
  }
  const service = createClient<Database>(supabaseEnv().url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    return Response.json({ received: true, result: await applyTracking(service, orgId, body) });
  } catch {
    // 500 → Shippo redelivers; applying the same status twice is a no-op. An ambiguous
    // tracking number also lands here: loud, never guessed.
    return Response.json({ error: "apply_failed" }, { status: 500 });
  }
}
