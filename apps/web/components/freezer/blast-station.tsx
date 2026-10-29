"use client";
import { useCallback, useState } from "react";
import { useStationSession, type StationSession } from "@/components/intake/use-station-session";
import { StationShell } from "@/src/components/station/station-shell";
import { ScanFeedback } from "@/src/components/station/scan-feedback";
import { useScanAction } from "@/src/components/station/use-scan-action";
import { permanentScanFailure } from "@/src/components/station/scan-failure";
import { useManualOptions, withEntryMethod } from "@/src/components/station/manual-entry";
import type { ScanReply, ScanRequest } from "@/src/components/station/scan-queue";
import { freezerReply, timeIn, useFreezerOperator } from "./use-freezer-operator";
import { FREEZER_INTAKE_STATES, useVesselRefresh } from "./live-vessels";

type InBlast = {
  id: string;
  blast_in_at: string;
  weight_lb: number;
  intake: { number: string } | null;
  asset_tag: { code: string } | null;
};

/** Sent to blast (intake released from reconcile) but not yet blasted in. */
export type WaitingVessel = {
  id: string;
  weight_lb: number;
  intake: { number: string; blast_at: string | null } | null;
  asset_tag: { code: string } | null;
};

/** Oldest release first (intake.blast_at), then a stable id order. */
export function waitingOrder(vessels: WaitingVessel[]): WaitingVessel[] {
  return [...vessels].sort(
    (a, b) =>
      (a.intake?.blast_at ?? "").localeCompare(b.intake?.blast_at ?? "") ||
      a.id.localeCompare(b.id),
  );
}

export function BlastStation() {
  const { session, loaded } = useStationSession();
  if (!loaded) return <main className="station">Opening blast station…</main>;
  if (!session)
    return (
      <main className="station">
        <h1>Blast</h1>
        <a href="/login">Sign in</a> or <a href="/pair">pair device</a>
      </main>
    );
  return <LiveBlast {...session} />;
}

/**
 * Scan a vessel tag → blast_in_at. Untagged exchange vessels have no tag to scan: they are
 * blasted in from the "waiting" list by tap (issue #86). Informational; no gate on time in blast.
 */
function LiveBlast({ client, claims, siteName }: StationSession) {
  const scope = `${claims.orgId}:${claims.userId}:blast`;
  const op = useFreezerOperator({ client, claims });
  const { expire } = op;
  const [vessels, setVessels] = useState<InBlast[]>([]);
  const [waiting, setWaiting] = useState<WaitingVessel[]>([]);
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(() => new Date());
  const refresh = useCallback(async () => {
    const [inBlast, released] = await Promise.all([
      client
        .from("vessel")
        .select("id,blast_in_at,weight_lb,intake(number),asset_tag!vessel_asset_tag_id_fkey(code)")
        .eq("lifecycle_state", "occupied")
        .not("blast_in_at", "is", null)
        .is("stored_at", null)
        .order("blast_in_at")
        .order("id"),
      client
        .from("vessel")
        .select(
          "id,weight_lb,intake!inner(number,blast_at,state),asset_tag!vessel_asset_tag_id_fkey(code)",
        )
        .eq("lifecycle_state", "occupied")
        .is("blast_in_at", null)
        .is("stored_at", null)
        .in("intake.state", [...FREEZER_INTAKE_STATES]),
    ]);
    if (inBlast.error || released.error) throw new Error("Blast refresh unavailable");
    setVessels((inBlast.data ?? []) as InBlast[]);
    setWaiting(waitingOrder((released.data ?? []) as WaitingVessel[]));
    setNow(new Date());
  }, [client]);
  const reload = useCallback(() => {
    void refresh().catch(() => setMessage("Refresh unavailable; check connection."));
  }, [refresh]);
  useVesselRefresh(client, claims.orgId, scope, reload);
  const send = useCallback(
    async (request: ScanRequest): Promise<ScanReply> => {
      const { data, error } = request.vessel_id
        ? await client.rpc("blast_vessel_by_id", {
            p_client_action_id: request.client_action_id,
            p_vessel_id: request.vessel_id,
            p_operator_session: request.operator_session ?? undefined,
          })
        : await withEntryMethod(
            client.rpc("blast_vessel", {
              p_client_action_id: request.client_action_id,
              p_raw: request.raw,
              p_operator_session: request.operator_session ?? undefined,
            }),
            request.entry_method,
          );
      if (error) {
        const rejection = permanentScanFailure(error);
        if (rejection) return rejection;
        throw new Error("Scan delivery unavailable");
      }
      const reply = freezerReply(data);
      if (reply.reason === "operator_pin_required") expire();
      void refresh().catch(() => undefined);
      return reply;
    },
    [client, expire, refresh],
  );
  const { scan, pending, feedback } = useScanAction(scope, send);
  const manual = useManualOptions(client, claims.orgId);
  const blastIn = (vesselId: string) => {
    if (op.allowed())
      void scan({
        raw: "",
        vessel_id: vesselId,
        station: "blast",
        client_action_id: crypto.randomUUID(),
        operator_session: op.proof,
      });
  };
  return (
    <StationShell
      name="Blast"
      site={siteName}
      operator={op.operator}
      pending={pending}
      paused={op.pinOpen}
      status={
        <>
          <ScanFeedback feedback={feedback} />
          <p role="status">{message}</p>
        </>
      }
      manual={{ ...manual, accept: ["TAG"] }}
      onScan={(raw, _parsed, method) => {
        if (op.allowed())
          void scan({
            raw,
            station: "blast",
            client_action_id: crypto.randomUUID(),
            operator_session: op.proof,
            entry_method: method,
          });
      }}
    >
      {waiting.length > 0 && (
        <section className="station-card" aria-label="Waiting for blast-in">
          <h2>RELEASED, WAITING FOR BLAST-IN ({waiting.length})</h2>
          <p>Scan a tagged vessel. Tap Blast in for an exchange basket (no tag).</p>
          <ul>
            {waiting.map((v) => (
              <li key={v.id} className="text-2xl">
                {v.asset_tag?.code ?? "Exchange"} · {v.intake?.number} · {v.weight_lb} lb
                {!v.asset_tag && (
                  <>
                    {" "}
                    <button
                      type="button"
                      aria-label={`Blast in exchange basket ${v.intake?.number ?? ""}`.trim()}
                      onClick={() => blastIn(v.id)}
                    >
                      Blast in
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="station-card" aria-label="In blast">
        <h2>IN BLAST ({vessels.length})</h2>
        <p>Scan a vessel tag as it goes into the blast freezer.</p>
        <ul>
          {vessels.map((v) => (
            <li key={v.id} className="text-2xl">
              {v.asset_tag?.code ?? "Exchange"} · {v.intake?.number} · {v.weight_lb} lb ·{" "}
              {timeIn(v.blast_in_at, now)}
            </li>
          ))}
        </ul>
        {vessels.length === 0 && waiting.length === 0 && <p>Blast freezer empty</p>}
      </section>
      {op.overlay}
    </StationShell>
  );
}
