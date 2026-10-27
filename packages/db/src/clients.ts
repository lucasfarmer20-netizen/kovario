import { createBrowserClient, createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";

/** A Supabase client typed with Filletry's generated schema. Always the anon key + a user JWT. */
export type FilletryClient = SupabaseClient<Database>;

export type SupabaseEnv = { url: string; anonKey: string };

/**
 * Staff session on the server (Server Components, Server Actions, Route Handlers).
 * The session lives in cookies; the caller passes its framework's cookie adapter.
 */
export function serverClient(env: SupabaseEnv, cookies: CookieMethodsServer): FilletryClient {
  return createServerClient<Database>(env.url, env.anonKey, { cookies });
}

/** Staff session in the browser, sharing the cookie session with serverClient. */
export function browserClient(env: SupabaseEnv): FilletryClient {
  return createBrowserClient<Database>(env.url, env.anonKey);
}

/** The subset of Web Storage the device session needs (window.localStorage satisfies it). */
export type DeviceStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** localStorage key of a paired station's session (separate from any staff cookie session). */
export const DEVICE_SESSION_STORAGE_KEY = "filletry-device-session";

/**
 * A paired station device's client. The device's own auth user session (minted by the
 * `device-pair` Edge Function) is persisted on the device and refreshed automatically.
 */
export function deviceClient(env: SupabaseEnv, storage?: DeviceStorage): FilletryClient {
  return createClient<Database>(env.url, env.anonKey, {
    auth: {
      storageKey: DEVICE_SESSION_STORAGE_KEY,
      storage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
}
