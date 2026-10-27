"use client";
import { useCallback, useEffect, useState } from "react";
import { useStationSession, type StationSession } from "@/components/intake/use-station-session";
import { StationShell } from "@/src/components/station/station-shell";
import { ScanFeedback } from "@/src/components/station/scan-feedback";
import { useScanAction } from "@/src/components/station/use-scan-action";
import { permanentScanFailure } from "@/src/components/station/scan-failure";
import type { ScanReply, ScanRequest } from "@/src/components/station/scan-queue";
import { freezerReply, useFreezerOperator, type FreezerReply } from "./use-freezer-operator";

export type PendingVessel = {
  raw: string;
  tag: string | null;
  intake: string | null;
  species: string | null;
};

function readPending(key: string): PendingVessel | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as PendingVessel | null;
    return value && typeof value.raw === "string" ? value : null;
  } catch {
    return null;
  }
}

/** The loop's next pending vessel: placed → reset; accepted tag → hold it; rejection → keep. */
export function nextPending(
  current: PendingVessel | null,
  reply: FreezerReply,
): PendingVessel | null {
  if (reply.placed) return null;
  if (reply.ok && reply.pending_vessel_raw)
    return {
      raw: reply.pending_vessel_raw,
      tag: reply.tag_code ?? null,
      intake: reply.intake_number ?? null,
      species: reply.species ?? null,
    };
  return current;
}

export function LocateStation() {
  const { session, loaded } = useStationSession();
  if (!loaded) return <main className="station">Opening locate station…</main>;
  if (!session)
    return (
      <main className="station">
        <h1>Locate</h1>
        <a href="/login">Sign in</a> or <a href="/pair">pair device</a>
      </main>
    );
  return <LiveLocate {...session} />;
}

/**
 * Two-step loop: scan a vessel tag (shows intake and species), then scan a location; the
 * placement is written and both steps reset. Archived / unknown locations are rejected by
 * the server. No capacity hints and no fill guidance: the crew chooses F or R.
 */
function LiveLocate({ client, claims, siteName }: StationSession) {
  const scope = `${claims.orgId}:${claims.userId}:locate`;
  const op = useFreezerOperator({ client, claims });
  const { expire } = op;
  const [pendingVessel, setPendingVessel] = useState<PendingVessel | null>(() =>
    typeof window === "undefined" ? null : readPending(scope),
  );
  const remember = useCallback(
    (value: PendingVessel | null) => {
      localStorage.setItem(scope, JSON.stringify(value));
      setPendingVessel(value);
    },
    [scope],
  );
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.storageArea === localStorage && (event.key === scope || event.key === null))
        setPendingVessel(readPending(scope));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [scope]);
  const send = useCallback(
    async (request: ScanRequest): Promise<ScanReply> => {
      // ScanQueue holds scan-delivery:<scope> across this call, so the pending vessel read
      // here is the one left by the previously delivered scan, even from another tab.
      const current = readPending(scope);
      const { data, error } = await client.rpc("locate_scan", {
        p_client_action_id: request.client_action_id,
        p_raw: request.raw,
        p_pending_vessel_raw: current?.raw ?? undefined,
        p_operator_session: request.operator_session ?? undefined,
      });
      if (error) {
        const rejection = permanentScanFailure(error);
        if (rejection) return rejection;
        throw new Error("Scan delivery unavailable");
      }
      const reply = freezerReply(data);
      remember(nextPending(current, reply));
      if (reply.reason === "operator_pin_required") expire();
      return reply;
    },
    [client, expire, remember, scope],
  );
  const { scan, pending, feedback } = useScanAction(scope, send);
  const cancel = async () => {
    await navigator.locks.request(`scan-delivery:${scope}`, () => remember(null));
  };
  return (
    <StationShell
      name="Locate"
      site={siteName}
      operator={op.operator}
      pending={pending}
      paused={op.pinOpen}
      status={<ScanFeedback feedback={feedback} />}
      onScan={(raw) => {
        if (op.allowed())
          void scan({
            raw,
            station: "locate",
            client_action_id: crypto.randomUUID(),
            operator_session: op.proof,
          });
      }}
    >
      <section className="station-card" aria-label="Locate step">
        {pendingVessel ? (
          <>
            <h2>STEP 2 — SCAN LOCATION</h2>
            <h3 className="text-5xl">{pendingVessel.tag ?? "Vessel"}</h3>
            <p className="text-3xl">{pendingVessel.intake}</p>
            {pendingVessel.species && <p>{pendingVessel.species}</p>}
            <button disabled={pending > 0} onClick={() => void cancel()}>
              Scan a different vessel
            </button>
          </>
        ) : (
          <>
            <h2>STEP 1 — SCAN VESSEL TAG</h2>
            <p>Scan the basket&apos;s tag, then the shelf or pallet location.</p>
          </>
        )}
      </section>
      {op.overlay}
    </StationShell>
  );
}
