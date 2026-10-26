import type { SupabaseEnv } from "db";

/** Public Supabase settings (anon key + URL). Never the service role key. */
export function supabaseEnv(): SupabaseEnv {
  // Referenced literally so Next inlines them into client bundles.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set (see .env.example)");
  }
  return { url, anonKey };
}
