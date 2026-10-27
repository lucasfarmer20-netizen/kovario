"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { filletryClaims, type FilletryClaims, type FilletryClient } from "db";
import Link from "next/link";
import { encode } from "rules";
import { getDeviceClient } from "@/lib/supabase/device";
import { getBrowserClient } from "@/lib/supabase/browser";
import { StationShell } from "@/src/components/station/station-shell";
import { ScanFeedback } from "@/src/components/station/scan-feedback";
import { OperatorPinOverlay, ManagerPinOverlay } from "@/src/components/station/pin-overlay";
import { QueueList, useRealtimeQueue, type QueueItem } from "@/src/components/station/queue-list";
import { useScanAction } from "@/src/components/station/use-scan-action";
import type { ScanRequest } from "@/src/components/station/scan-queue";
import { demoScan } from "./actions";

type Context = {
  client: FilletryClient;
  claims: FilletryClaims;
  station: ScanRequest["station"];
  site: string;
};
const stations: string[] = ["wave", "rollstock", "reconcile", "blast", "locate", "boxing"];
export function StationDemo() {
  const [context, setContext] = useState<Context | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      for (const client of [getDeviceClient(), getBrowserClient()]) {
        const { data } = await client.auth.getClaims();
        const claims = filletryClaims(data?.claims);
        if (!claims || claims.appRole === "agent") continue;
        let station: ScanRequest["station"] = "wave";
        let site = "Main";
        if (claims.deviceId) {
          const { data: device } = await client
            .from("device")
            .select("station, site_id")
            .eq("id", claims.deviceId)
            .single();
          if (!device || !stations.includes(device.station)) break;
          station = device.station as ScanRequest["station"];
          const { data: row } = await client
            .from("site")
            .select("name")
            .eq("id", device.site_id ?? "")
            .single();
          site = row?.name ?? "Station site";
        }
        if (live) setContext({ client, claims, station, site });
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
  if (!loaded)
    return (
      <main className="station">
        <p>Opening station…</p>
      </main>
    );
  if (!context)
    return (
      <main className="station">
        <h1>Station gallery</h1>
        <p>Sign in as staff or pair a scan-station device to try the live primitives.</p>
        <Link href="/login">Staff sign in</Link>
        <br />
        <Link href="/pair">Pair device</Link>
      </main>
    );
  return <LiveStation {...context} />;
}
function LiveStation({ client, claims, station, site }: Context) {
  const isDevice = claims.appRole === "station";
  const [operator, setOperator] = useState<string | null>(isDevice ? null : "Signed-in staff");
  const [operatorSession, setOperatorSession] = useState<string | null>(null);
  const [pinOpen, setPinOpen] = useState(isDevice);
  const [managerOpen, setManagerOpen] = useState(false);
  const [managerMessage, setManagerMessage] = useState("");
  const [items, setItems] = useState<QueueItem[]>([]);
  const [queueError, setQueueError] = useState("");
  const lastInteraction = useRef(0);
  const send = useCallback(
    async (request: ScanRequest) => {
      const { data } = await client.auth.getSession();
      if (!data.session) throw new Error("Sign in required");
      const reply = await demoScan(request, data.session.access_token);
      if (reply.reason === "operator_pin_required") {
        setOperator(null);
        setOperatorSession(null);
        setPinOpen(true);
      }
      return reply;
    },
    [client],
  );
  const { scan, pending, feedback } = useScanAction(
    `${claims.orgId}:${claims.userId}:${station}`,
    send,
  );
  const refresh = useCallback(() => {
    void client
      .from("intake")
      .select("id, number, intake_at, tote_count")
      .eq("state", "holding")
      .order("intake_at")
      .then(({ data, error }) => {
        setQueueError(error ? "Queue refresh unavailable" : "");
        if (data)
          setItems(
            data.map((row) => ({
              id: row.id,
              label: row.number,
              enteredAt: row.intake_at,
              detail: `${row.tote_count} totes`,
            })),
          );
      });
  }, [client]);
  useRealtimeQueue(client, claims.orgId, refresh);
  useEffect(() => {
    if (!isDevice) return;
    const activity = () => {
      if (Date.now() - lastInteraction.current >= 15 * 60_000) {
        setOperator(null);
        setOperatorSession(null);
        setPinOpen(true);
      } else if (operator) lastInteraction.current = Date.now();
    };
    window.addEventListener("pointerdown", activity);
    window.addEventListener("keydown", activity);
    const timer = setInterval(() => {
      if (Date.now() - lastInteraction.current >= 15 * 60_000) {
        setOperator(null);
        setOperatorSession(null);
        setPinOpen(true);
      }
    }, 1000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("keydown", activity);
    };
  }, [isDevice, operator]);
  return (
    <StationShell
      name="Station gallery"
      site={site}
      operator={operator}
      pending={pending}
      paused={pinOpen || managerOpen}
      status={<ScanFeedback feedback={feedback} />}
      onScan={(raw) => {
        if (isDevice && (!operator || Date.now() - lastInteraction.current >= 15 * 60_000)) {
          setPinOpen(true);
          return;
        }
        void scan({
          raw,
          station,
          client_action_id: crypto.randomUUID(),
          operator_session: operatorSession,
        });
      }}
    >
      <div className="station-workspace">
        <section className="station-card">
          <p className="station-eyebrow">Shared station primitives · {station}</p>
          <h2>Scan a tote to begin</h2>
          <p>
            Paste or scan <code>{encode("TOTE", { intakeNumber: "INT-0001", toteNo: 1 })}</code>,
            then press Enter.
          </p>
          <p>
            Only totes in this plant’s intake master are accepted. Unknown labels are recorded as
            rejected scans.
          </p>
          <div className="station-actions">
            <button onClick={() => setPinOpen(true)}>Operator PIN</button>
            <button onClick={() => setManagerOpen(true)}>Manager approval</button>
          </div>
          <p role="status">{managerMessage}</p>
          {queueError && <p role="alert">{queueError}</p>}
          <p className="station-hint">
            Scans are saved on this device before sending. Keep this page open to replay pending
            scans after reconnecting.
          </p>
        </section>
        <QueueList items={items} />
      </div>
      {pinOpen && (
        <OperatorPinOverlay
          onClose={() => setPinOpen(false)}
          verify={async (pin) => {
            const { data, error } = await client.rpc("station_identify", { p_pin: pin });
            const result = data as {
              ok: boolean;
              reason?: string;
              member?: { display_name: string };
              session_id?: string;
            } | null;
            if (error || !result?.ok || !result.session_id)
              return {
                ok: false,
                reason: result?.reason ?? "PIN identification requires a paired device",
              };
            setOperator(result.member?.display_name ?? "Operator");
            setOperatorSession(result.session_id);
            lastInteraction.current = Date.now();
            return { ok: true };
          }}
        />
      )}
      {managerOpen && (
        <ManagerPinOverlay
          onClose={() => setManagerOpen(false)}
          verify={async (pin) => {
            const { data, error } = await client.functions.invoke("elevate", { body: { pin } });
            if (error || !data?.ok)
              return { ok: false, reason: "Manager PIN rejected or service unavailable" };
            // Demo consumes approval immediately; real gated actions pass token to app.require_elevation.
            const { data: status, error: statusError } = await client.rpc("elevation_status", {
              p_token: String(data.token),
            });
            if (statusError || !(status as { active?: boolean })?.active)
              return { ok: false, reason: "Approval expired" };
            setManagerMessage("Manager approval verified");
            return { ok: true };
          }}
        />
      )}
    </StationShell>
  );
}
