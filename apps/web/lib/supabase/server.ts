import { serverClient, type FilletryClient } from "db";
import { cookies } from "next/headers";
import { supabaseEnv } from "./env";

/** Staff session client for Server Components and Server Actions (user JWT, RLS applies). */
export async function createSupabaseServer(): Promise<FilletryClient> {
  const store = await cookies();
  return serverClient(supabaseEnv(), {
    getAll: () => store.getAll(),
    setAll: (list) => {
      try {
        for (const { name, value, options } of list) store.set(name, value, options);
      } catch {
        // Server Components cannot set cookies; proxy.ts refreshes the session instead.
      }
    },
  });
}
