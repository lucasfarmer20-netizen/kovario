"use client";
import { useCallback, useEffect, useState } from "react";
import type { Database, FilletryClient } from "db";
import { varianceHoldLimit } from "rules";

/** One member of an active variance hold's group (public.variance_hold_member, #87). */
export type HoldMember = Pick<
  Database["public"]["Views"]["variance_hold_member"]["Row"],
  | "hold_id"
  | "flagged_intake_id"
  | "intake_id"
  | "intake_number"
  | "position"
  | "state"
  | "variance_pct"
  | "band"
  | "blocked"
  | "limit_pct"
>;

const COLUMNS =
  "hold_id,flagged_intake_id,intake_id,intake_number,position,state,variance_pct,band,blocked,limit_pct";

/**
 * The hold group containing `intakeId`, in rollstock order, or null. An intake's own hold wins
 * over a neighbour's.
 */
export function holdGroupFor(
  members: readonly HoldMember[],
  intakeId: string,
): HoldMember[] | null {
  const mine = members.filter((m) => m.intake_id === intakeId);
  const hold = mine.find((m) => m.flagged_intake_id === intakeId) ?? mine[0];
  if (!hold) return null;
  return members
    .filter((m) => m.hold_id === hold.hold_id)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

/** Intakes a hold currently blocks from Send to Blast. */
export function blockedIntakes(members: readonly HoldMember[]): Set<string> {
  return new Set(members.flatMap((m) => (m.blocked && m.intake_id ? [m.intake_id] : [])));
}

/** Active holds and the org's limit: now, on hold / intake / vessel changes, and every 15 s. */
export function useVarianceHolds(client: FilletryClient, orgId: string, scope: string) {
  const [members, setMembers] = useState<HoldMember[]>([]);
  const [limit, setLimit] = useState<number>(() => varianceHoldLimit({}));
  const refresh = useCallback(async () => {
    const [holds, org] = await Promise.all([
      client
        .from("variance_hold_member")
        .select(COLUMNS)
        .eq("hold_state", "active")
        .order("hold_id")
        .order("position"),
      client.from("org").select("settings"),
    ]);
    if (!holds.error) setMembers((holds.data ?? []) as HoldMember[]);
    const settings = org.data?.[0]?.settings;
    if (!org.error && settings && typeof settings === "object" && !Array.isArray(settings))
      setLimit(varianceHoldLimit(settings));
  }, [client]);
  useEffect(() => {
    const reload = () => void refresh();
    reload();
    const channel = client.channel(`${scope}:variance-holds`);
    for (const table of ["variance_hold", "intake", "vessel"])
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: `org_id=eq.${orgId}` },
        reload,
      );
    channel.subscribe();
    const timer = setInterval(reload, 15000);
    return () => {
      clearInterval(timer);
      void client.removeChannel(channel);
    };
  }, [client, orgId, refresh, scope]);
  return { members, limit, refresh };
}
