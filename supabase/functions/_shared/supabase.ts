// Shared helpers for Filletry Edge Functions. Secrets come from the function runtime env
// (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected by Supabase).
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function preflight(): Response {
  return new Response("ok", { headers: corsHeaders });
}

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

/** Service-role client. Edge Functions are one of the few places service role is allowed. */
export function serviceClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), noSession);
}

export function anonClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), noSession);
}

/** A client that acts as the caller, so RLS and app.org_id() apply to its queries. */
export function callerClient(accessToken: string): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    ...noSession,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export type Caller = {
  accessToken: string;
  userId: string;
  orgId: string;
  appRole: string;
  deviceId: string | null;
};

/** Verifies the bearer token and returns its Filletry claims, or null. */
export async function verifyCaller(req: Request): Promise<Caller | null> {
  const header = req.headers.get("Authorization") ?? "";
  const accessToken = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!accessToken) return null;
  const { data, error } = await anonClient().auth.getClaims(accessToken);
  const claims = data?.claims;
  if (error || !claims || claims.role !== "authenticated") return null;
  const orgId = typeof claims.org_id === "string" ? claims.org_id : null;
  const appRole = typeof claims.app_role === "string" ? claims.app_role : null;
  if (!claims.sub || !orgId || !appRole) return null;
  return {
    accessToken,
    userId: claims.sub,
    orgId,
    appRole,
    deviceId: typeof claims.device_id === "string" ? claims.device_id : null,
  };
}

/** 32 random bytes, hex. Used for throwaway device passwords. */
export function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
