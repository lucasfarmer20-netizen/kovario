"use client";
import { useEffect } from "react";
import type { StationSession } from "@/components/intake/use-station-session";

/** Freezer station lists: reload now, on any vessel change in the org (Realtime), and every 30 s. */
export function useVesselRefresh(
  client: StationSession["client"],
  orgId: string,
  scope: string,
  reload: () => void,
) {
  useEffect(() => {
    reload();
    const channel = client.channel(scope);
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "vessel", filter: `org_id=eq.${orgId}` },
      reload,
    );
    channel.subscribe();
    const timer = setInterval(reload, 30000);
    return () => {
      clearInterval(timer);
      void client.removeChannel(channel);
    };
  }, [client, orgId, reload, scope]);
}

/** Intake states whose vessels are in the freezer path (sent to blast, or already stored). */
export const FREEZER_INTAKE_STATES = ["blast_freezer", "stored"] as const;
