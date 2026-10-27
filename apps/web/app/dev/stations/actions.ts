"use server";
import { createClient } from "@supabase/supabase-js";
import { filletryClaims, withAction, type Database, type Json } from "db";
import { parse } from "rules";
import { supabaseEnv } from "@/lib/supabase/env";
import type { ScanRequest, ScanReply } from "@/src/components/station/scan-queue";

export async function demoScan(request: ScanRequest, accessToken: string): Promise<ScanReply> {
  const env = supabaseEnv();
  const client = createClient<Database>(env.url, env.anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getClaims(accessToken);
  if (error || !filletryClaims(data?.claims)) throw new Error("Station sign-in required");
  if (typeof request.raw !== "string" || typeof request.client_action_id !== "string") {
    return { ok: false, reason: "Invalid scan request" };
  }
  const parsed = parse(request.raw);
  const result = await withAction(client, request.client_action_id, async (id) => {
    const { data: reply, error: rpcError } = await client.rpc("station_scan", {
      p_client_action_id: id,
      p_raw: request.raw,
      p_station: request.station,
      p_parsed: parsed.ok ? (parsed.value as unknown as Json) : null,
      p_reason: parsed.ok ? undefined : parsed.reason,
      p_operator_session: request.operator_session ?? undefined,
    });
    if (rpcError) throw new Error("Scan service unavailable");
    return reply;
  });
  return result as unknown as ScanReply;
}
