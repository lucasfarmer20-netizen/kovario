"use client";

import { browserClient, type FilletryClient } from "db";
import { supabaseEnv } from "./env";

let client: FilletryClient | undefined;

/** Staff session in the browser (shares the cookie session with the server). */
export function getBrowserClient(): FilletryClient {
  client ??= browserClient(supabaseEnv());
  return client;
}
