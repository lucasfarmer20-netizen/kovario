"use client";
import { useEffect, useState } from "react";
import { filletryClaims, type FilletryClaims, type FilletryClient } from "db";
import { getBrowserClient } from "@/lib/supabase/browser";
import { getDeviceClient } from "@/lib/supabase/device";

export type StationSession = {
  client: FilletryClient;
  claims: FilletryClaims;
  siteName: string;
};

const ROLES = new Set(["owner", "manager", "staff", "cashier", "station"]);

/**
 * The intake desk's session: a paired station device (localStorage) first, else the signed-
 * in staff session. `null` once loaded means neither is available.
 */
export function useStationSession(): { session: StationSession | null; loaded: boolean } {
  const [session, setSession] = useState<StationSession | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      for (const client of [getDeviceClient(), getBrowserClient()]) {
        const { data } = await client.auth.getClaims();
        const claims = filletryClaims(data?.claims);
        if (!claims || !ROLES.has(claims.appRole)) continue;
        let siteName = "Plant";
        if (claims.deviceId) {
          const { data: device } = await client
            .from("device")
            .select("site:site_id (name)")
            .eq("id", claims.deviceId)
            .maybeSingle();
          siteName = device?.site?.name ?? siteName;
        }
        if (live) setSession({ client, claims, siteName });
        break;
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, []);
  return { session, loaded };
}

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  manager: "Manager",
  staff: "Staff",
  cashier: "Cashier",
};

/**
 * Who is at a keyboard station, for the console bar's operator chip: a paired tablet, or the
 * signed-in account's role. These desks have no operator PIN; with no session the chip asks to
 * identify the operator (sign in or pair).
 */
export function sessionLabel(session: StationSession | null): string | null {
  if (!session) return null;
  if (session.claims.deviceId) return "Station tablet";
  return ROLE_LABELS[session.claims.appRole] ?? "Signed in";
}

/** Verifies a manager PIN with the `elevate` Edge Function; returns the elevation token. */
export async function managerElevation(
  client: FilletryClient,
  pin: string,
): Promise<{ token: string } | { reason: string }> {
  const { data, error } = await client.functions.invoke("elevate", { body: { pin } });
  if (error || !data?.ok || typeof data.token !== "string") {
    return { reason: typeof data?.reason === "string" ? data.reason : "Manager PIN rejected" };
  }
  return { token: data.token };
}
