"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Database, Json } from "db";
import { hoursInCooler } from "rules";
import {
  managerElevation,
  useStationSession,
  type StationSession,
} from "@/components/intake/use-station-session";
import { StationShell } from "@/src/components/station/station-shell";
import { DisabledReason } from "@/src/components/station/next-step";
import { ScanFeedback } from "@/src/components/station/scan-feedback";
import { OperatorPinOverlay, ManagerPinOverlay } from "@/src/components/station/pin-overlay";
import { useOperatorIdle } from "@/src/components/station/use-operator-idle";
import { useScanAction } from "@/src/components/station/use-scan-action";
import { permanentScanFailure } from "@/src/components/station/scan-failure";
import { useManualOptions, withEntryMethod } from "@/src/components/station/manual-entry";
import type { ScanReply, ScanRequest } from "@/src/components/station/scan-queue";

type Intake = Database["public"]["Tables"]["intake"]["Row"] & {
  intake_line: { species_code: string }[];
};
type Reply = ScanReply & { open_intake_id: string | null };
export function rollstockReply(data: Json): Reply {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    typeof data.ok !== "boolean" ||
    typeof data.reason !== "string" ||
    (data.open_intake_id !== null && typeof data.open_intake_id !== "string")
  )
    throw new Error("Invalid rollstock response");
  return data as Reply;
}
export function RollstockStation() {
  const { session, loaded } = useStationSession();
  if (!loaded) return <main className="station">Opening rollstock station…</main>;
  if (!session)
    return (
      <main className="station">
        <h1>Rollstock</h1>
        <Link href="/login">Sign in</Link> or <Link href="/pair">pair device</Link>
      </main>
    );
  return <LiveRollstock {...session} />;
}
function LiveRollstock({ client, claims, siteName }: StationSession) {
  const scope = `${claims.orgId}:${claims.userId}:rollstock`;
  const [openId, setOpenId] = useState<string | null>(null);
  const [intakes, setIntakes] = useState<Intake[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [operator, setOperator] = useState<string | null>(
    claims.appRole === "station" ? null : "Signed-in staff",
  );
  const [proof, setProof] = useState<string | null>(null);
  const [pinOpen, setPinOpen] = useState(claims.appRole === "station");
  const [managerOpen, setManagerOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const expire = useCallback(() => {
    setOperator(null);
    setProof(null);
    setPinOpen(true);
  }, []);
  const idle = useOperatorIdle(claims.appRole === "station" && operator !== null, expire);
  const remember = useCallback(
    (id: string | null) => {
      localStorage.setItem(scope, id ?? "");
      setOpenId(id);
    },
    [scope],
  );
  const refresh = useCallback(async () => {
    const [rows, progress] = await Promise.all([
      client
        .from("intake")
        .select("*, intake_line(species_code)")
        .in("state", ["holding", "processing", "rollstock"])
        .order("intake_at")
        .order("id"),
      client.from("rollstock_tote_progress").select("intake_id, scanned"),
    ]);
    if (rows.error || progress.error) throw new Error("Rollstock refresh unavailable");
    setIntakes(rows.data ?? []);
    setCounts(Object.fromEntries((progress.data ?? []).map((r) => [r.intake_id, r.scanned ?? 0])));
  }, [client]);
  useEffect(() => {
    const syncOpen = () => setOpenId(localStorage.getItem(scope) || null);
    syncOpen();
    const storageChanged = (event: StorageEvent) => {
      if (event.storageArea === localStorage && (event.key === scope || event.key === null))
        syncOpen();
    };
    window.addEventListener("storage", storageChanged);
    const reload = () => {
      void refresh().catch(() => setMessage("Rollstock refresh unavailable. Retry connection."));
    };
    reload();
    const channel = client.channel(`rollstock:${claims.orgId}`);
    for (const table of ["intake", "scan_log", "wave_scan"])
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: `org_id=eq.${claims.orgId}` },
        reload,
      );
    channel.subscribe();
    const timer = setInterval(reload, 15000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("storage", storageChanged);
      void client.removeChannel(channel);
    };
  }, [client, claims.orgId, refresh, scope]);
  const send = useCallback(
    async (request: ScanRequest): Promise<ScanReply> => {
      // ScanQueue holds scan-delivery:<scope> across this call. Read shared state
      // inside that lock: another tab may have delivered the previous scan, even
      // if its storage event has not reached this tab yet.
      const { data, error } = await withEntryMethod(
        client.rpc("rollstock_scan_advance", {
          p_raw: request.raw,
          p_open_intake_id: (localStorage.getItem(scope) || null)!,
          p_client_action_id: request.client_action_id,
          p_operator_session: request.operator_session ?? undefined,
        }),
        request.entry_method,
      );
      if (error) {
        const rejection = permanentScanFailure(error);
        if (rejection) return rejection;
        throw new Error("Scan delivery unavailable");
      }
      const reply = rollstockReply(data);
      remember(reply.open_intake_id);
      if (reply.reason === "operator_pin_required") expire();
      void refresh().catch(() => undefined);
      return reply;
    },
    [client, expire, refresh, remember, scope],
  );
  const { scan, pending, feedback } = useScanAction(scope, send);
  const manual = useManualOptions(client, claims.orgId);
  const allowed = () => {
    if (claims.appRole === "station" && (!operator || idle.check())) {
      setPinOpen(true);
      return false;
    }
    return true;
  };
  const finish = async (token?: string) => {
    if (!allowed() || pending || busy) return;
    setBusy(true);
    try {
      await navigator.locks.request(`scan-delivery:${scope}`, async () => {
        const { data, error } = await client.rpc("rollstock_scan_advance", {
          p_raw: null!,
          p_open_intake_id: (localStorage.getItem(scope) || null)!,
          p_client_action_id: crypto.randomUUID(),
          p_operator_session: proof ?? undefined,
          p_override_reason: token !== undefined ? overrideReason : undefined,
          p_elevation_token: token,
        });
        if (error) throw new Error(error.message);
        const reply = rollstockReply(data);
        remember(reply.open_intake_id);
        setMessage(reply.reason);
        if (reply.reason === "operator_pin_required") expire();
      });
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Finish unavailable");
    } finally {
      setBusy(false);
    }
  };
  const selectOpen = async (id: string | null) => {
    await navigator.locks.request(`scan-delivery:${scope}`, () => remember(id));
  };
  const open = intakes.find((i) => i.id === openId);
  return (
    <StationShell
      name="Rollstock"
      site={siteName}
      operator={operator}
      pending={pending}
      paused={pinOpen || managerOpen || busy}
      next={open ? "Scan the next tote" : "Scan a tote"}
      manualLabel="Tote number (INT-0002-1)"
      status={
        <>
          <ScanFeedback feedback={feedback} />
          <p role="status">{message}</p>
        </>
      }
      manual={{ ...manual, accept: ["TOTE"] }}
      onScan={(raw, _parsed, method) => {
        if (allowed())
          void scan({
            raw,
            station: "rollstock",
            client_action_id: crypto.randomUUID(),
            operator_session: proof,
            entry_method: method,
          });
      }}
    >
      <div className="station-workspace">
        <section className="station-card" aria-label="Open at rollstock">
          <h2>OPEN AT ROLLSTOCK</h2>
          {open ? (
            <>
              <h3 className="text-5xl">{open.number}</h3>
              <p className="text-3xl">
                Order {open.number} · tote {counts[open.id] ?? 0} of {open.tote_count}
              </p>
              <p>{[...new Set(open.intake_line.map((line) => line.species_code))].join(", ")}</p>
              <p>
                {open.fast_pass && "FAST PASS · "}
                {open.dirty_fish && "DIRTY · "}
                {open.ribbing && "RIBBING"}
              </p>
              <p>{open.dirty_notes}</p>
              <p>{open.cut_notes}</p>
              <p>{open.processing_notes}</p>
            </>
          ) : (
            <p>Scan a tote to open an order.</p>
          )}
          <button
            className="opacity-70"
            disabled={!open || pending > 0 || busy || pinOpen}
            onClick={() => void finish()}
          >
            Finish queue
          </button>
          <DisabledReason reason={!open && "Scan a tote first"} />
          {openId && !open && (
            <button disabled={pending > 0 || busy} onClick={() => void selectOpen(null)}>
              Clear stale open order
            </button>
          )}
          {open && (counts[open.id] ?? 0) < open.tote_count && (
            <details>
              <summary className="min-h-14 cursor-pointer py-4">Manager override</summary>
              <label>
                Reason
                <input
                  aria-label="Override reason"
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                />
              </label>
              <button
                disabled={pending > 0 || busy || pinOpen || overrideReason.trim().length < 3}
                onClick={() => setManagerOpen(true)}
              >
                Approve incomplete totes and finish
              </button>
              <DisabledReason reason={overrideReason.trim().length < 3 && "Enter a reason first"} />
            </details>
          )}
        </section>
        <section className="station-card">
          <h2>NEXT UP</h2>
          {intakes
            .filter((i) => i.state !== "rollstock")
            .map((i) => (
              <p key={i.id}>
                {i.number} · {i.tote_count} totes ·{" "}
                {hoursInCooler(new Date(i.intake_at), new Date())}h since drop-off ·{" "}
                {i.state === "holding" ? "Cooler bypass" : "Processing"}
              </p>
            ))}
          {!intakes.some((i) => i.state !== "rollstock") && <p>Queue empty</p>}
          {intakes
            .filter((i) => i.state === "rollstock" && i.id !== openId)
            .map((i) => (
              <button
                key={i.id}
                disabled={pending > 0 || busy}
                onClick={() => void selectOpen(i.id)}
              >
                Resume {i.number}
              </button>
            ))}
        </section>
      </div>
      {pinOpen && (
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
      )}
      {managerOpen && (
        <ManagerPinOverlay
          onClose={() => setManagerOpen(false)}
          verify={async (pin) => {
            const elevation = await managerElevation(client, pin);
            if ("reason" in elevation) return { ok: false, reason: elevation.reason };
            await finish(elevation.token);
            return { ok: true };
          }}
        />
      )}
    </StationShell>
  );
}
