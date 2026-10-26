// End-to-end device pairing, operator PIN and manager elevation through the Edge Functions
// served by `supabase start` (docs/01-ARCHITECTURE.md §5).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kovarioClaims } from "./claims";
import {
  anonClient,
  createOrg,
  createUser,
  dropOrg,
  localSupabase,
  type TestOrg,
  type TestUser,
} from "./testing/local-supabase";

type PairResponse = {
  session?: { access_token: string; refresh_token: string };
  device?: { id: string; org_id: string; name: string; station: string };
  error?: string;
};

async function pair(code: string): Promise<{ status: number; body: PairResponse }> {
  const s = localSupabase();
  const res = await fetch(`${s.API_URL}/functions/v1/device-pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: s.ANON_KEY },
    body: JSON.stringify({ code }),
  });
  return { status: res.status, body: (await res.json()) as PairResponse };
}

// The first Edge Function call on a fresh `supabase start` (CI) fetches its npm imports.
describe("device pairing", { timeout: 60_000 }, () => {
  let org: TestOrg;
  let manager: TestUser;
  let staff: TestUser;
  let deviceId: string;

  beforeAll(async () => {
    org = await createOrg();
    manager = await createUser(org, "manager");
    staff = await createUser(org, "staff");
    const { data, error } = await manager.client.rpc("admin_create_device", {
      p_name: "Intake 1",
      p_station: "intake",
    });
    if (error) throw error;
    deviceId = data;
  });

  afterAll(async () => {
    await dropOrg(org);
  });

  it("pairs a device and returns a station session for its own auth user", async () => {
    const { data: codes, error } = await manager.client.rpc("admin_device_pairing_code", {
      p_device_id: deviceId,
    });
    expect(error).toBeNull();
    const code = codes?.[0]?.code ?? "";

    const { status, body } = await pair(code);
    expect(status).toBe(200);
    expect(body.device).toMatchObject({ id: deviceId, org_id: org.id, station: "intake" });

    const device = anonClient();
    await device.auth.setSession(body.session ?? { access_token: "", refresh_token: "" });
    const { data: user } = await device.auth.getUser();
    expect(user.user?.email).toBe(`device-${deviceId}@devices.kovario.internal`);
    const { data: claims } = await device.auth.getClaims();
    expect(kovarioClaims(claims?.claims)).toEqual({
      userId: user.user?.id,
      orgId: org.id,
      appRole: "station",
      deviceId,
    });

    // The station is scoped to its org and can heartbeat.
    expect((await device.rpc("device_heartbeat")).error).toBeNull();
    const { data: seen } = await manager.client
      .from("device")
      .select("last_seen_at, paired_at")
      .eq("id", deviceId);
    expect(seen?.[0]?.paired_at).toBeTruthy();
    expect(seen?.[0]?.last_seen_at).toBeTruthy();

    // Operator PIN identification at the station.
    const { data: members } = await manager.client.rpc("admin_list_members");
    const staffMember = members?.find((m) => m.user_id === staff.id);
    const managerMember = members?.find((m) => m.user_id === manager.id);
    expect(
      (
        await manager.client.rpc("admin_set_member_pin", {
          p_member_id: staffMember?.id ?? "",
          p_pin: "2468",
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await manager.client.rpc("admin_set_member_pin", {
          p_member_id: managerMember?.id ?? "",
          p_pin: "13579",
        })
      ).error,
    ).toBeNull();
    const { data: who } = await device.rpc("operator_identify", { p_pin: "2468" });
    expect(who).toMatchObject({ ok: true, member: { id: staffMember?.id } });

    // Manager PIN elevation through the Edge Function.
    const denied = await device.functions.invoke("elevate", { body: { pin: "2468" } });
    expect(denied.error).toBeTruthy();
    const elevated = await device.functions.invoke<{ ok: boolean; token: string }>("elevate", {
      body: { pin: "13579" },
    });
    expect(elevated.data?.ok).toBe(true);
    const { data: statusNow } = await device.rpc("elevation_status", {
      p_token: elevated.data?.token ?? "",
    });
    expect(statusNow).toMatchObject({ active: true, manager: { id: managerMember?.id } });
  });

  it("a pairing code works once", async () => {
    const { data: codes } = await manager.client.rpc("admin_device_pairing_code", {
      p_device_id: deviceId,
    });
    const code = codes?.[0]?.code ?? "";
    expect((await pair(code)).status).toBe(200);
    const again = await pair(code);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("invalid_or_expired_code");
  });

  it("re-pairing keeps the same device auth user", async () => {
    const { data: before } = await manager.client
      .from("device")
      .select("auth_user_id")
      .eq("id", deviceId)
      .single();
    const { data: codes } = await manager.client.rpc("admin_device_pairing_code", {
      p_device_id: deviceId,
    });
    expect((await pair(codes?.[0]?.code ?? "")).status).toBe(200);
    const { data: after } = await manager.client
      .from("device")
      .select("auth_user_id")
      .eq("id", deviceId)
      .single();
    expect(after?.auth_user_id).toBe(before?.auth_user_id);
  });

  it("re-pairing revokes the previous tablet's session", async () => {
    const issue = async () =>
      (await manager.client.rpc("admin_device_pairing_code", { p_device_id: deviceId })).data?.[0]
        ?.code ?? "";

    // The old tablet holds a working session.
    const first = await pair(await issue());
    expect(first.status).toBe(200);
    const oldTablet = anonClient();
    await oldTablet.auth.setSession(first.body.session ?? { access_token: "", refresh_token: "" });
    expect((await oldTablet.auth.refreshSession()).error).toBeNull();
    const { data: oldSession } = await oldTablet.auth.getSession();
    const oldRefreshToken = oldSession.session?.refresh_token ?? "";

    // A manager re-pairs the device on a new tablet.
    const second = await pair(await issue());
    expect(second.status).toBe(200);

    // The old tablet can no longer mint tokens; the new one can.
    const stale = await anonClient().auth.refreshSession({ refresh_token: oldRefreshToken });
    expect(stale.error).toBeTruthy();
    expect(stale.data.session).toBeNull();

    const newTablet = anonClient();
    await newTablet.auth.setSession(second.body.session ?? { access_token: "", refresh_token: "" });
    expect((await newTablet.auth.refreshSession()).error).toBeNull();
  });

  it("staff cannot issue pairing codes", async () => {
    const { error } = await staff.client.rpc("admin_device_pairing_code", {
      p_device_id: deviceId,
    });
    expect(error?.code).toBe("42501");
  });

  it("a manager invites a member through the member-invite function", async () => {
    const email = `invitee-${Date.now()}@test.kovario`;
    const { data, error } = await manager.client.functions.invoke<{
      member_id: string;
      invited: boolean;
    }>("member-invite", { body: { email, display_name: "Ivy Invitee", role: "cashier" } });
    expect(error).toBeNull();
    expect(data?.invited).toBe(true);
    const { data: members } = await manager.client.rpc("admin_list_members");
    expect(members?.find((m) => m.email === email)).toMatchObject({
      role: "cashier",
      display_name: "Ivy Invitee",
    });

    const forbidden = await staff.client.functions.invoke("member-invite", {
      body: { email: `x-${Date.now()}@test.kovario`, display_name: "X", role: "staff" },
    });
    expect(forbidden.error).toBeTruthy();
  });
});
