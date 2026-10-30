"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { type Database, type Json } from "db";
import { suggestWave, hoursInCooler } from "rules";
import { useStationSession, type StationSession } from "@/components/intake/use-station-session";
import { StationShell } from "@/src/components/station/station-shell";
import { DisabledReason } from "@/src/components/station/next-step";
import { ScanFeedback } from "@/src/components/station/scan-feedback";
import { OperatorPinOverlay } from "@/src/components/station/pin-overlay";
import { useOperatorIdle } from "@/src/components/station/use-operator-idle";
import { useScanAction } from "@/src/components/station/use-scan-action";
import { permanentScanFailure } from "@/src/components/station/scan-failure";
import { useManualOptions, withEntryMethod } from "@/src/components/station/manual-entry";
import type { ScanRequest, ScanReply } from "@/src/components/station/scan-queue";

type Intake = Database["public"]["Tables"]["intake"]["Row"] & {
  intake_line: { species_code: string }[];
};
type Wave = Database["public"]["Tables"]["wave"]["Row"];
const STEPS = ["Add orders", "Scan totes", "Complete"] as const;
/** The next step line and current step (docs/11-FLOOR-WORDING.md, Wave). */
export function waveNextStep(
  wave: Pick<Wave, "state"> | undefined,
  chosen: number,
  scanned: number,
  expected: number,
): { next: string; step: number } {
  if (!wave) return { next: chosen ? "Tap Create wave" : "Tap orders to add to the wave", step: 0 };
  if (wave.state === "draft") return { next: "Tap Start verification", step: 0 };
  if (expected === 0 || scanned < expected)
    return { next: `Scan each tote (${scanned} of ${expected})`, step: 1 };
  return { next: "Complete wave", step: 2 };
}
function result(data: Json): ScanReply {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    typeof data.ok !== "boolean" ||
    typeof data.reason !== "string"
  )
    throw new Error("Invalid wave response");
  return data as ScanReply;
}
export function WaveStation() {
  const { session, loaded } = useStationSession();
  if (!loaded) return <main className="station">Opening wave station…</main>;
  if (!session)
    return (
      <main className="station">
        <h1>Wave station</h1>
        <Link href="/login">Sign in</Link> or <Link href="/pair">pair device</Link>
      </main>
    );
  return <LiveWave {...session} />;
}
function LiveWave({ client, claims, siteName }: StationSession) {
  const [intakes, setIntakes] = useState<Intake[]>([]);
  const [waves, setWaves] = useState<Wave[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [target, setTarget] = useState(4000);
  const [tolerance, setTolerance] = useState(250);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [operator, setOperator] = useState<string | null>(
    claims.appRole === "station" ? null : "Signed-in staff",
  );
  const [proof, setProof] = useState<string | null>(null);
  const [pinOpen, setPinOpen] = useState(claims.appRole === "station");
  const expire = useCallback(() => {
    setOperator(null);
    setProof(null);
    setPinOpen(true);
  }, []);
  const idle = useOperatorIdle(claims.appRole === "station" && operator !== null, expire);
  const refresh = useCallback(async () => {
    const [i, w, o] = await Promise.all([
      client
        .from("intake")
        .select("*, intake_line(species_code)")
        .eq("state", "holding")
        .order("intake_at")
        .order("id"),
      client.from("wave").select("*").in("state", ["draft", "verifying"]).order("created_at"),
      client.from("org").select("settings").eq("id", claims.orgId).single(),
    ]);
    if (i.error || w.error || o.error) throw new Error("Wave refresh unavailable");
    const scanCounts = await Promise.all(
      (w.data ?? []).map(async (wave) => {
        const { count, error } = await client
          .from("wave_scan")
          .select("id", { count: "exact", head: true })
          .eq("wave_id", wave.id);
        if (error || count === null) throw new Error("Wave scan count unavailable");
        return [wave.id, count] as const;
      }),
    );
    setIntakes(i.data ?? []);
    setWaves(w.data ?? []);
    setCounts(Object.fromEntries(scanCounts));
    const settings = o.data?.settings as {
      wave_target_lb?: number;
      wave_tolerance_lb?: number;
    } | null;
    setTarget(settings?.wave_target_lb ?? 4000);
    setTolerance(settings?.wave_tolerance_lb ?? 250);
  }, [client, claims.orgId]);
  useEffect(() => {
    const reload = () => {
      void refresh().catch(() => setMessage("Wave refresh unavailable. Retry before completing."));
    };
    reload();
    const channel = client.channel(`wave:${claims.orgId}`);
    for (const table of ["intake", "wave", "wave_scan"])
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: `org_id=eq.${claims.orgId}` },
        reload,
      );
    channel.subscribe();
    const timer = setInterval(reload, 15000);
    return () => {
      clearInterval(timer);
      void client.removeChannel(channel);
    };
  }, [client, claims.orgId, refresh]);
  const send = useCallback(
    async (request: ScanRequest): Promise<ScanReply> => {
      const { data, error } = await withEntryMethod(
        client.rpc("scan_wave_tote", {
          p_wave_id: request.wave_id ?? "00000000-0000-0000-0000-000000000000",
          p_raw: request.raw,
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
      const reply = result(data);
      if (reply.reason === "operator_pin_required") expire();
      void refresh().catch(() => undefined);
      return reply;
    },
    [client, expire, refresh],
  );
  const { scan, pending, feedback } = useScanAction(`${claims.orgId}:${claims.userId}:wave`, send);
  const manual = useManualOptions(client, claims.orgId);
  const wave = waves.find((w) => w.id === active);
  const queue = intakes.filter((i) => !i.wave_id);
  const members = intakes.filter((i) => i.wave_id === active);
  const expected = members.reduce((n, i) => n + i.tote_count, 0);
  const scanned = active ? (counts[active] ?? 0) : 0;
  const chosen = queue.filter((i) => selected.includes(i.id));
  const prompt = waveNextStep(wave, chosen.length, scanned, expected);
  const completeWhy =
    wave?.state === "verifying" && (expected === 0 || scanned !== expected)
      ? `Scan every tote first (${scanned} of ${expected})`
      : null;
  const allowed = () => {
    if (claims.appRole === "station" && (!operator || idle.check())) {
      setPinOpen(true);
      return false;
    }
    return true;
  };
  const mutate = async (create: boolean, cancel = false) => {
    if (!allowed()) return;
    setBusy(true);
    setMessage("");
    try {
      const id = crypto.randomUUID();
      const response = create
        ? await client.rpc("create_wave", {
            p_intake_ids: chosen.map((i) => i.id),
            p_client_action_id: id,
            p_operator_session: proof ?? undefined,
          })
        : await client.rpc(cancel ? "cancel_wave" : "advance_wave", {
            p_wave_id: active!,
            p_client_action_id: id,
            p_operator_session: proof ?? undefined,
          });
      if (response.error) throw new Error(response.error.message);
      const data = response.data as { ok: boolean; reason?: string; wave_id?: string };
      if (data.wave_id) {
        setActive(data.wave_id);
        setSelected([]);
      }
      setMessage(data.reason ?? "Wave created. Start verification when ready.");
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Wave update unavailable");
    } finally {
      setBusy(false);
    }
  };
  return (
    <StationShell
      name="Wave batch"
      site={siteName}
      operator={operator}
      pending={pending}
      paused={pinOpen}
      next={prompt.next}
      steps={STEPS}
      step={prompt.step}
      manualLabel="Tote number (INT-0002-1)"
      status={
        <>
          <ScanFeedback feedback={feedback} />
          <p role="status">{message}</p>
        </>
      }
      manual={{ ...manual, accept: ["TOTE"] }}
      onScan={(raw, _parsed, method) => {
        if (!allowed()) return;
        void scan({
          raw,
          station: "wave",
          wave_id: active ?? undefined,
          client_action_id: crypto.randomUUID(),
          operator_session: proof,
          entry_method: method,
        });
      }}
    >
      <div className="station-workspace">
        <section className="station-card">
          <h2>Holding · oldest first</h2>
          <p>
            Target {target} ± {tolerance} lb · suggestion only
          </p>
          <button
            disabled={busy || pinOpen}
            onClick={() => setSelected(suggestWave(queue, target, tolerance).map((i) => i.id))}
          >
            Suggest FIFO fill
          </button>
          {queue.map((i) => (
            <button
              className="block w-full text-left my-2"
              key={i.id}
              aria-pressed={selected.includes(i.id)}
              disabled={busy || pinOpen}
              onClick={() =>
                setSelected((ids) =>
                  ids.includes(i.id) ? ids.filter((id) => id !== i.id) : [...ids, i.id],
                )
              }
            >
              <strong>
                {selected.includes(i.id) ? "✓ " : "+ "}
                {i.number}
              </strong>{" "}
              · {hoursInCooler(new Date(i.intake_at), new Date())}h in cooler ·{" "}
              {i.total_incoming_lb} lb · {i.tote_count} totes
              <span className="block">
                {[...new Set(i.intake_line.map((l) => l.species_code))].join(", ")}{" "}
                {i.fast_pass && " · FAST PASS"} {i.dirty_fish && " · DIRTY"}{" "}
                {i.ribbing && " · RIBBING"}
              </span>
            </button>
          ))}
          {!queue.length && <p>No orders waiting in the cooler</p>}
          <p>
            {chosen.length} selected · {chosen.reduce((sum, i) => sum + i.total_incoming_lb, 0)} lb
          </p>
          <button disabled={busy || pinOpen || !chosen.length} onClick={() => void mutate(true)}>
            Create wave
          </button>
          <DisabledReason reason={!chosen.length && "Tap orders first"} />
        </section>
        <section className="station-card">
          <h2>Verify totes</h2>
          <div className="station-actions">
            {waves.map((w) => (
              <button key={w.id} aria-pressed={active === w.id} onClick={() => setActive(w.id)}>
                {w.number} · {w.state}
              </button>
            ))}
          </div>
          {wave ? (
            <>
              <h3>{wave.number}</h3>
              <p className="text-3xl">
                {scanned} / {expected} totes
              </p>
              {members.map((i) => (
                <p key={i.id}>
                  {i.number} · {i.tote_count} totes
                </p>
              ))}
              <button
                disabled={busy || pinOpen || pending > 0 || completeWhy !== null}
                onClick={() => void mutate(false)}
              >
                {wave.state === "draft" ? "Start Verification" : "Complete — Start Processing"}
              </button>
              <DisabledReason reason={completeWhy} />
              <button
                disabled={busy || pinOpen || pending > 0}
                onClick={() => void mutate(false, true)}
              >
                Cancel wave — Return to holding
              </button>
            </>
          ) : (
            <p>Tap a wave, or create one from the orders in the cooler.</p>
          )}
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
    </StationShell>
  );
}
