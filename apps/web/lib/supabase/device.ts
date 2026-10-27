"use client";

import { deviceClient, type FilletryClient } from "db";
import { supabaseEnv } from "./env";

let client: FilletryClient | undefined;

/** The paired station's client (device session in localStorage). Browser only. */
export function getDeviceClient(): FilletryClient {
  client ??= deviceClient(supabaseEnv(), window.localStorage);
  return client;
}
