"use server";
import { createClient } from "@supabase/supabase-js";
import { filletryClaims, withAction, type Database, type Json } from "db";
import { parse } from "rules";
import { supabaseEnv } from "@/lib/supabase/env";
import { permanentScanFailure } from "@/src/components/station/scan-failure";
import type { ScanRequest, ScanReply } from "@/src/components/station/scan-queue";

export async function demoScan(request: ScanRequest, accessToken: string): Promise<ScanReply> {
  const env = supabaseEnv();
  const client = createClient<Database>(env.url, env.anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    const { data, error } = await client.auth.getClaims(accessToken);
    if (error) {
      if (permanentScanFailure(error)) return { ok: false, reason: "station_sign_in_required" };
      throw new Error("Scan service unavailable");
    }
    if (!filletryClaims(data?.claims)) return { ok: false, reason: "station_sign_in_required" };
    if (typeof request.raw !== "string" || typeof request.client_action_id !== "string") {
      return { ok: false, reason: "scan_request_rejected" };
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
      if (rpcError) {
        const rejection = permanentScanFailure(rpcError);
        if (rejection) return rejection;
        throw new Error("Scan service unavailable");
      }
      return reply;
    });
    // A key already used by another action can return a non-scan result through withAction.
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      typeof result.ok !== "boolean" ||
      typeof result.reason !== "string"
    ) {
      return { ok: false, reason: "scan_conflict" };
    }
    return result as ScanReply;
  } catch (error) {
    const rejection = permanentScanFailure(error);
    if (rejection) return rejection;
    throw new Error("Scan service unavailable");
  }
}
