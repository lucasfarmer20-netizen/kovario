// Fixtures for `*.db.test.ts` suites (run by `pnpm test:db` against `supabase start`).
// Connection details come from `supabase status`; nothing is hard-coded.
import { execSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import type { KovarioClient } from "../clients";
import type { Database } from "../types";

type Status = { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string; DB_URL: string };

let cached: Status | undefined;

export function localSupabase(): Status {
  if (!cached) {
    const root = fileURLToPath(new URL("../../../..", import.meta.url));
    const out = execSync("pnpm exec supabase status -o json", {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    cached = JSON.parse(out.slice(out.indexOf("{"))) as Status;
  }
  return cached;
}

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

export function serviceRoleClient(): KovarioClient {
  const s = localSupabase();
  return createClient<Database>(s.API_URL, s.SERVICE_ROLE_KEY, noSession);
}

export function anonClient(): KovarioClient {
  const s = localSupabase();
  return createClient<Database>(s.API_URL, s.ANON_KEY, noSession);
}

export type TestOrg = { id: string; slug: string };

export async function createOrg(): Promise<TestOrg> {
  const slug = `test-${randomUUID().slice(0, 8)}`;
  const { data, error } = await serviceRoleClient()
    .from("org")
    .insert({ slug, name: slug, timezone: "UTC" })
    .select("id, slug")
    .single();
  if (error) throw error;
  return data;
}

export type TestUser = { id: string; email: string; client: KovarioClient };

/** Creates an auth user, optionally a member of `org`, and returns a signed-in client. */
export async function createUser(
  org: TestOrg | null,
  role: Database["public"]["Enums"]["org_member_role"] = "staff",
): Promise<TestUser> {
  const admin = serviceRoleClient();
  const email = `${randomUUID()}@test.kovario`;
  const password = randomBytes(24).toString("hex");
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  if (org) {
    const { error: memberError } = await admin
      .from("org_member")
      .insert({ org_id: org.id, user_id: data.user.id, role, display_name: email.slice(0, 8) });
    if (memberError) throw memberError;
  }
  const client = anonClient();
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  return { id: data.user.id, email, client };
}

export async function dropOrg(org: TestOrg): Promise<void> {
  const admin = serviceRoleClient();
  const { data: devices } = await admin.from("device").select("auth_user_id").eq("org_id", org.id);
  const { data: members } = await admin.from("org_member").select("user_id").eq("org_id", org.id);
  await admin.from("org").delete().eq("id", org.id);
  const userIds = [
    ...(devices ?? []).map((d) => d.auth_user_id),
    ...(members ?? []).map((m) => m.user_id),
  ];
  for (const id of userIds) if (id) await admin.auth.admin.deleteUser(id);
}
