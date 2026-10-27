// POST /functions/v1/device-pair  { code }  →  { session, device }
// Called by an unpaired tablet with only the anon key (docs/01-ARCHITECTURE.md §5).
// Redeems the one-time pairing code, creates (or rotates) the per-device auth user
// `device-<id>@devices.filletry.internal`, signs it in and returns the session. The
// password is random, used once here and never stored or returned.
import { anonClient, json, preflight, randomSecret, serviceClient } from "../_shared/supabase.ts";

const DEVICE_EMAIL_DOMAIN = "devices.filletry.internal";

type Redeemed = {
  device_id: string;
  org_id: string;
  auth_user_id: string | null;
  name: string;
  station: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const body = await req.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!/^[A-Za-z0-9]{8}$/.test(code)) return json({ error: "invalid_code" }, 400);

  const admin = serviceClient();
  const { data: rows, error: redeemError } = await admin.rpc("device_redeem_pairing", { p_code: code });
  const device = (rows as Redeemed[] | null)?.[0];
  if (redeemError || !device) return json({ error: "invalid_or_expired_code" }, 400);

  const email = `device-${device.device_id}@${DEVICE_EMAIL_DOMAIN}`;
  const password = randomSecret();

  let userId = device.auth_user_id;
  if (userId) {
    const { error } = await admin.auth.admin.updateUserById(userId, { password });
    if (error) userId = null; // auth user was removed; create a fresh one below
  }
  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { kind: "device", device_id: device.device_id },
    });
    if (error || !data.user) {
      console.error("device-pair: createUser failed", error?.message);
      return json({ error: "pairing_failed" }, 500);
    }
    userId = data.user.id;
  }

  const { error: bindError } = await admin.rpc("device_bind_auth_user", {
    p_device_id: device.device_id,
    p_user_id: userId,
  });
  if (bindError) {
    console.error("device-pair: bind failed", bindError.message);
    return json({ error: "pairing_failed" }, 500);
  }

  const { data: signIn, error: signInError } = await anonClient().auth.signInWithPassword({
    email,
    password,
  });
  if (signInError || !signIn.session) {
    console.error("device-pair: sign-in failed", signInError?.message);
    return json({ error: "pairing_failed" }, 500);
  }

  return json({
    session: {
      access_token: signIn.session.access_token,
      refresh_token: signIn.session.refresh_token,
    },
    device: {
      id: device.device_id,
      org_id: device.org_id,
      name: device.name,
      station: device.station,
    },
  });
});
