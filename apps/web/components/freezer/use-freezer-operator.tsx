"use client";
import { useCallback, useState } from "react";
import type { Json } from "db";
import type { StationSession } from "@/components/intake/use-station-session";
import { OperatorPinOverlay } from "@/src/components/station/pin-overlay";
import { useOperatorIdle } from "@/src/components/station/use-operator-idle";
import type { ScanReply } from "@/src/components/station/scan-queue";

export type FreezerReply = ScanReply & {
  vessel_id?: string | null;
  tag_code?: string | null;
  intake_number?: string | null;
  species?: string | null;
  location_code?: string | null;
  placed?: boolean;
  pending_vessel_raw?: string | null;
  pending_vessel_id?: string | null;
  reset?: boolean;
};

export function freezerReply(data: Json): FreezerReply {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    typeof data.ok !== "boolean" ||
    typeof data.reason !== "string"
  )
    throw new Error("Invalid freezer reply");
  return data as FreezerReply;
}

/** Operator PIN proof for scan-only freezer stations (station devices only). */
export function useFreezerOperator({ client, claims }: Pick<StationSession, "client" | "claims">) {
  const station = claims.appRole === "station";
  const [operator, setOperator] = useState<string | null>(station ? null : "Signed-in staff");
  const [proof, setProof] = useState<string | null>(null);
  const [pinOpen, setPinOpen] = useState(station);
  const expire = useCallback(() => {
    setOperator(null);
    setProof(null);
    setPinOpen(true);
  }, []);
  const idle = useOperatorIdle(station && operator !== null, expire);
  const allowed = () => {
    if (station && (!operator || idle.check())) {
      setPinOpen(true);
      return false;
    }
    return true;
  };
  const overlay = pinOpen ? (
    <OperatorPinOverlay
      onClose={() => setPinOpen(false)}
      verify={async (pin) => {
        const { data, error } = await client.rpc("station_identify", { p_pin: pin });
        const r = data as {
          ok?: boolean;
          session_id?: string;
          member?: { display_name: string };
          reason?: string;
        } | null;
        if (error || !r?.ok || !r.session_id)
          return { ok: false, reason: r?.reason ?? "PIN rejected" };
        setOperator(r.member?.display_name ?? "Operator");
        setProof(r.session_id);
        idle.reset();
        return { ok: true };
      }}
    />
  ) : null;
  return { operator, proof, pinOpen, expire, allowed, overlay };
}

/** "2h 05m" since `from`. */
export function timeIn(from: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(from).getTime()) / 60000));
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
