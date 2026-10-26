"use client";

import { browserClient, type KovarioClient } from "db";
import { supabaseEnv } from "./env";

let client: KovarioClient | undefined;

/** Staff session in the browser (shares the cookie session with the server). */
export function getBrowserClient(): KovarioClient {
  client ??= browserClient(supabaseEnv());
  return client;
}
