// POST /functions/v1/elevate  { pin }  (Authorization: caller's access token)
//   → { ok: true, token, expires_at, manager } | { ok: false, reason, locked_until }
// Manager PIN elevation (docs/01-ARCHITECTURE.md §5): verifies a manager/owner PIN in the
// caller's org and mints a short-lived opaque token bound to the caller. Gated SQL
// functions check it with app.require_elevation(token).
import { json, preflight, serviceClient, verifyCaller } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const caller = await verifyCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => null);
  const pin = typeof body?.pin === "string" ? body.pin : "";

  const { data, error } = await serviceClient().rpc("elevation_mint", {
    p_org_id: caller.orgId,
    p_user_id: caller.userId,
    p_device_id: caller.deviceId,
    p_pin: pin,
  });
  if (error) {
    console.error("elevate: mint failed", error.code);
    return json({ error: "elevation_failed" }, error.code === "42501" ? 403 : 500);
  }
  return json(data, data?.ok ? 200 : 403);
});
