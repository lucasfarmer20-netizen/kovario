"use client";
import { useCallback, useEffect, useState } from "react";
import { useStationSession, type StationSession } from "@/components/intake/use-station-session";
import { StationShell } from "@/src/components/station/station-shell";
import { ScanFeedback } from "@/src/components/station/scan-feedback";
import { useScanAction } from "@/src/components/station/use-scan-action";
import { permanentScanFailure } from "@/src/components/station/scan-failure";
import type { ScanReply, ScanRequest } from "@/src/components/station/scan-queue";
import { freezerReply, timeIn, useFreezerOperator } from "./use-freezer-operator";

type InBlast = {
  id: string;
  blast_in_at: string;
  weight_lb: number;
  intake: { number: string } | null;
  asset_tag: { code: string } | null;
};

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

/** Scan a vessel tag → blast_in_at. Informational queue; no gate on time in blast. */
function LiveBlast({ client, claims, siteName }: StationSession) {
  const scope = `${claims.orgId}:${claims.userId}:blast`;
  const op = useFreezerOperator({ client, claims });
  const { expire } = op;
  const [vessels, setVessels] = useState<InBlast[]>([]);
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(() => new Date());
  const refresh = useCallback(async () => {
    const { data, error } = await client
      .from("vessel")
      .select("id,blast_in_at,weight_lb,intake(number),asset_tag(code)")
      .eq("lifecycle_state", "occupied")
      .not("blast_in_at", "is", null)
      .is("stored_at", null)
      .order("blast_in_at")
      .order("id");
    if (error) throw new Error("Blast refresh unavailable");
    setVessels((data ?? []) as InBlast[]);
    setNow(new Date());
  }, [client]);
  useEffect(() => {
    const reload = () => {
      void refresh().catch(() => setMessage("Refresh unavailable; check connection."));
    };
    reload();
    const channel = client.channel(scope);
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "vessel", filter: `org_id=eq.${claims.orgId}` },
      reload,
    );
    channel.subscribe();
    const timer = setInterval(reload, 30000);
    return () => {
      clearInterval(timer);
      void client.removeChannel(channel);
    };
  }, [client, claims.orgId, refresh, scope]);
  const send = useCallback(
    async (request: ScanRequest): Promise<ScanReply> => {
      const { data, error } = await client.rpc("blast_vessel", {
        p_client_action_id: request.client_action_id,
        p_raw: request.raw,
        p_operator_session: request.operator_session ?? undefined,
      });
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
      onScan={(raw) => {
        if (op.allowed())
          void scan({
            raw,
            station: "blast",
            client_action_id: crypto.randomUUID(),
            operator_session: op.proof,
          });
      }}
    >
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
        {vessels.length === 0 && <p>Blast freezer empty</p>}
      </section>
      {op.overlay}
    </StationShell>
  );
}
