"use client";

import { deviceClient, type KovarioClient } from "db";
import { supabaseEnv } from "./env";

let client: KovarioClient | undefined;

/** The paired station's client (device session in localStorage). Browser only. */
export function getDeviceClient(): KovarioClient {
  client ??= deviceClient(supabaseEnv(), window.localStorage);
  return client;
}
