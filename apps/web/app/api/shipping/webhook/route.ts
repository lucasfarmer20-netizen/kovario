import { createClient } from "@supabase/supabase-js";
import type { Database } from "db";
import { tokensMatch } from "shipping";
import { supabaseEnv } from "@/lib/supabase/env";
import { applyTracking } from "@/lib/shipping/service";

// POST /api/shipping/webhook?token=…  (Shippo → Filletry, track_updated). docs/07 §4.
// Shippo does not sign webhooks: the URL registered in Shippo carries SHIPPO_WEBHOOK_TOKEN,
// compared in constant time. Tracking numbers are global, so the shipment is found across orgs
// with the service role (shipping_apply_tracking); nothing else is readable or writable here.
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const expected = process.env.SHIPPO_WEBHOOK_TOKEN;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!expected || !serviceKey) return Response.json({ error: "not_configured" }, { status: 503 });
  if (!tokensMatch(new URL(req.url).searchParams.get("token"), expected)) {
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
    return Response.json({ received: true, result: await applyTracking(service, body) });
  } catch {
    // 500 → Shippo redelivers; applying the same status twice is a no-op.
    return Response.json({ error: "apply_failed" }, { status: 500 });
  }
}
