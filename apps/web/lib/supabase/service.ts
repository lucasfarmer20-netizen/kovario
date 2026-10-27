import { createClient } from "@supabase/supabase-js";
import type { Database, FilletryClient } from "db";
import { supabaseEnv } from "./env";

/**
 * Service-role client. Import ONLY from the /api/payments/* route handlers (docs/05-PAYMENTS.md
 * §1, AGENTS.md hard rule 1): it records provider outcomes and reads terminal secrets, which no
 * browser session may do. Never import it from a page, component or server action.
 */
export function serviceRoleClient(): FilletryClient {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set (payments route handlers need it)");
  return createClient<Database>(supabaseEnv().url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** The caller's own session (staff or paired station) from its bearer token: RLS applies. */
export function bearerClient(accessToken: string): FilletryClient {
  const env = supabaseEnv();
  return createClient<Database>(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}
