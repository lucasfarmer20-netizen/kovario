// POST /functions/v1/member-invite  { email, display_name, role }  (Authorization: manager)
//   → { member_id, invited }
// Creating auth users needs the service role, which apps/web may not use, so invites run
// here. The membership itself is written with the caller's JWT through
// public.admin_add_member, so the role checks stay in SQL.
import { callerClient, json, preflight, serviceClient, verifyCaller } from "../_shared/supabase.ts";

const ROLES = ["owner", "manager", "staff", "cashier"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const caller = await verifyCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);
  if (caller.appRole !== "owner" && caller.appRole !== "manager") {
    return json({ error: "forbidden" }, 403);
  }

  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const displayName = typeof body?.display_name === "string" ? body.display_name.trim() : "";
  const role = typeof body?.role === "string" ? body.role : "";
  const redirectTo = typeof body?.redirect_to === "string" ? body.redirect_to : undefined;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !displayName || !ROLES.includes(role)) {
    return json({ error: "invalid_input" }, 400);
  }
  if (email.endsWith("@devices.kovario.internal")) return json({ error: "invalid_input" }, 400);
  if (role === "owner" && caller.appRole !== "owner") return json({ error: "forbidden" }, 403);

  const admin = serviceClient();
  let invited = true;
  let userId: string | null = null;
  const { data: invite, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo,
  });
  if (invite?.user) {
    userId = invite.user.id;
  } else {
    // Existing account: add the membership without a new invite.
    const { data: existing } = await admin.rpc("member_lookup_user", { p_email: email });
    if (typeof existing !== "string") {
      console.error("member-invite: invite failed", inviteError?.code);
      return json({ error: "invite_failed" }, 500);
    }
    userId = existing;
    invited = false;
  }

  const { data: memberId, error: addError } = await callerClient(caller.accessToken).rpc(
    "admin_add_member",
    { p_user_id: userId, p_role: role, p_display_name: displayName },
  );
  if (addError) {
    const status = addError.code === "23505" ? 409 : addError.code === "42501" ? 403 : 400;
    return json({ error: addError.message }, status);
  }
  return json({ member_id: memberId, invited });
});
