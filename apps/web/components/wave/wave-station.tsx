"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { type Database, type Json } from "db";
import { suggestWave, hoursInCooler } from "rules";
import { useStationSession, type StationSession } from "@/components/intake/use-station-session";
import { speciesName } from "@/components/reconcile/reconcile-view";
import { StationShell } from "@/src/components/station/station-shell";
import { useOnline } from "@/src/components/station/connection-chip";
import { ScanFeedback } from "@/src/components/station/scan-feedback";
import { StationNotice, type NoticeTone } from "@/src/components/station/notice";
import { OperatorPinOverlay } from "@/src/components/station/pin-overlay";
import { useOperatorIdle } from "@/src/components/station/use-operator-idle";
import { useScanAction } from "@/src/components/station/use-scan-action";
import { permanentScanFailure } from "@/src/components/station/scan-failure";
import { stationMessage } from "@/src/components/station/messages";
import { useManualOptions, withEntryMethod } from "@/src/components/station/manual-entry";
import type { ScanRequest, ScanReply } from "@/src/components/station/scan-queue";
import { WaveView, type OpenWave, type WaveQueueItem, type WaveTile } from "./wave-view";

type Intake = Database["public"]["Tables"]["intake"]["Row"] & {
  intake_line: { species_code: string }[];
};
type Wave = Database["public"]["Tables"]["wave"]["Row"];
type ToteScan = { wave_id: string; intake_id: string; tote_no: number };
export const WAVE_STEPS = ["Add orders", "Scan totes", "Complete"] as const;

/** The next step line and current step (docs/11-FLOOR-WORDING.md, Wave). */
export function waveNextStep(
  wave: Pick<Wave, "state"> | undefined,
  chosen: number,
  scanned: number,
  expected: number,
): { next: string; step: number } {
  if (!wave)
    return { next: chosen ? "Tap Start verification" : "Tap orders to add to the wave", step: 0 };
  if (wave.state === "draft") return { next: "Tap Start verification", step: 0 };
  if (expected === 0 || scanned < expected)
    return { next: `Scan each tote (${scanned} of ${expected})`, step: 1 };
  return { next: "Complete wave", step: 2 };
}

/** Why each wave action waits (docs/11: disabled buttons say why); null when it can run. */
export function waveWhy({
  wave,
  chosen,
  scanned,
  expected,
  pending,
  online,
}: {
  wave: Pick<Wave, "state"> | undefined;
  chosen: number;
  scanned: number;
  expected: number;
  pending: number;
  online: boolean;
}): { start: string | null; advance: string | null; cancel: string | null } {
  const offline = online ? null : "Offline. Reconnect to update the wave.";
  const sending = pending
    ? `Wait for ${pending} pending ${pending === 1 ? "scan" : "scans"} to send`
    : null;
  const parity =
    wave?.state === "verifying" && (expected === 0 || scanned !== expected)
      ? `Scan every tote first (${scanned} of ${expected})`
      : null;
  return {
    start: chosen ? offline : "Tap orders first",
    advance: parity ?? offline ?? sending,
    cancel: offline ?? sending,
  };
}

const species = (i: Intake) =>
  [...new Set(i.intake_line.map((l) => speciesName(l.species_code)))].join(", ");
const totesText = (n: number) => `${n} ${n === 1 ? "tote" : "totes"}`;
const flags = (i: Intake) =>
  [i.fast_pass && "FAST PASS", i.dirty_fish && "DIRTY", i.ribbing && "RIBBING"].filter(
    (f): f is string => Boolean(f),
  );

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

/**
 * Which wave is on screen. "auto": the only open wave, if there is exactly one (so a reopened
 * station lands on the wave being checked); "new": the new-wave card; "wave": the one tapped.
 */
type View = { kind: "auto" } | { kind: "new" } | { kind: "wave"; id: string };
type Reply = { ok: boolean; reason?: string; wave_id?: string };

function LiveWave({ client, claims, siteName }: StationSession) {
  const [intakes, setIntakes] = useState<Intake[]>([]);
  const [waves, setWaves] = useState<Wave[]>([]);
  const [view, setView] = useState<View>({ kind: "auto" });
  const [selected, setSelected] = useState<string[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [totes, setTotes] = useState<ToteScan[]>([]);
  const [target, setTarget] = useState(4000);
  const [tolerance, setTolerance] = useState(250);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: NoticeTone }>({
    text: "",
    tone: "info",
  });
  // A refused update of the open wave, while nothing has been scanned since.
  const [refusal, setRefusal] = useState<{ id: string; scanned: number; text: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [operator, setOperator] = useState<string | null>(
    claims.appRole === "station" ? null : "Signed-in staff",
  );
  const [proof, setProof] = useState<string | null>(null);
  const [pinOpen, setPinOpen] = useState(claims.appRole === "station");
  const online = useOnline();
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
    const open = w.data ?? [];
    // Exact counts gate Complete; the tote rows only tick totes off on screen.
    const [scanCounts, scanRows] = await Promise.all([
      Promise.all(
        open.map(async (wave) => {
          const { count, error } = await client
            .from("wave_scan")
            .select("id", { count: "exact", head: true })
            .eq("wave_id", wave.id);
          if (error || count === null) throw new Error("Wave scan count unavailable");
          return [wave.id, count] as const;
        }),
      ),
      open.length
        ? client
            .from("wave_scan")
            .select("wave_id, intake_id, tote_no")
            .in(
              "wave_id",
              open.map((wave) => wave.id),
            )
        : Promise.resolve({ data: [] as ToteScan[], error: null }),
    ]);
    if (scanRows.error) throw new Error("Wave scan count unavailable");
    setIntakes(i.data ?? []);
    setWaves(open);
    setCounts(Object.fromEntries(scanCounts));
    setTotes((scanRows.data ?? []) as ToteScan[]);
    const settings = o.data?.settings as {
      wave_target_lb?: number;
      wave_tolerance_lb?: number;
    } | null;
    setTarget(settings?.wave_target_lb ?? 4000);
    setTolerance(settings?.wave_tolerance_lb ?? 250);
    setLoaded(true);
  }, [client, claims.orgId]);
  useEffect(() => {
    const reload = () => {
      void refresh().catch(() =>
        setMessage({ text: "Wave refresh unavailable. Retry before completing.", tone: "error" }),
      );
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

  const wave =
    view.kind === "wave"
      ? waves.find((w) => w.id === view.id)
      : view.kind === "auto" && waves.length === 1
        ? waves[0]
        : undefined;
  const verifying = waves.filter((w) => w.state === "verifying");
  const queue = intakes.filter((i) => !i.wave_id);
  const members = wave ? intakes.filter((i) => i.wave_id === wave.id) : [];
  const expected = members.reduce((n, i) => n + i.tote_count, 0);
  const scanned = wave ? (counts[wave.id] ?? 0) : 0;
  const chosen = queue.filter((i) => selected.includes(i.id));
  const refused =
    wave && refusal?.id === wave.id && refusal.scanned === scanned ? refusal.text : null;
  const prompt = waveNextStep(wave, chosen.length, scanned, expected);
  const why = waveWhy({ wave, chosen: chosen.length, scanned, expected, pending, online });
  const allowed = () => {
    if (claims.appRole === "station" && (!operator || idle.check())) {
      setPinOpen(true);
      return false;
    }
    return true;
  };
  const run = async (work: () => Promise<void>) => {
    if (!allowed()) return;
    setBusy(true);
    setMessage({ text: "", tone: "info" });
    try {
      await work();
    } catch (err) {
      setMessage({
        text: err instanceof Error ? stationMessage(err.message) : "Wave update unavailable",
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };
  const advance = async (id: string): Promise<Reply> => {
    const response = await client.rpc("advance_wave", {
      p_wave_id: id,
      p_client_action_id: crypto.randomUUID(),
      p_operator_session: proof ?? undefined,
    });
    if (response.error) throw new Error(response.error.message);
    return response.data as Reply;
  };
  // Flow (docs/06 Wave): one tap creates the wave and starts verification (create_wave then
  // advance_wave); a refused start leaves the wave in draft with Start Verification on it.
  const start = () =>
    run(async () => {
      const created = await client.rpc("create_wave", {
        p_intake_ids: chosen.map((i) => i.id),
        p_client_action_id: crypto.randomUUID(),
        p_operator_session: proof ?? undefined,
      });
      if (created.error) throw new Error(created.error.message);
      const id = (created.data as Reply).wave_id;
      if (!id) throw new Error((created.data as Reply).reason ?? "Wave update unavailable");
      // The wave exists now whatever the start does: open it once the refresh has it.
      const reply = await advance(id).catch((err: unknown) => err as Error);
      await refresh();
      setSelected([]);
      setView({ kind: "wave", id });
      if (reply instanceof Error) throw reply;
      setMessage(
        reply.ok
          ? { text: "Wave started. Scan each tote.", tone: "ok" }
          : { text: reply.reason ?? "Wave update unavailable", tone: "error" },
      );
    });
  const forward = () =>
    run(async () => {
      if (!wave) return;
      const reply = await advance(wave.id);
      if (!reply.ok) {
        const text = reply.reason ?? "Wave update unavailable";
        setRefusal({ id: wave.id, scanned, text });
        setMessage({ text, tone: "error" });
      } else if (wave.state === "draft") {
        setMessage({ text: `Wave ${wave.number} started. Scan each tote.`, tone: "ok" });
      } else {
        setView({ kind: "auto" });
        setMessage({
          text: `Wave ${wave.number} complete. Its orders are in processing.`,
          tone: "ok",
        });
      }
      await refresh();
    });
  const cancel = () =>
    run(async () => {
      if (!wave) return;
      const response = await client.rpc("cancel_wave", {
        p_wave_id: wave.id,
        p_client_action_id: crypto.randomUUID(),
        p_operator_session: proof ?? undefined,
      });
      if (response.error) throw new Error(response.error.message);
      const reply = response.data as Reply;
      if (reply.ok) {
        setRefusal(null);
        setView({ kind: "auto" });
      }
      setMessage({
        text: reply.reason ?? "Wave update unavailable",
        tone: reply.ok ? "ok" : "error",
      });
      await refresh();
    });

  const now = new Date();
  const queueItems: WaveQueueItem[] = queue.map((i) => ({
    id: i.id,
    number: i.number,
    detail: [species(i), `${i.total_incoming_lb} lb`, totesText(i.tote_count)]
      .filter(Boolean)
      .join(" · "),
    age: `${hoursInCooler(new Date(i.intake_at), now)}h in cooler`,
    flags: flags(i),
    lb: i.total_incoming_lb,
    totes: i.tote_count,
  }));
  const waveTiles: WaveTile[] = waves.map((w) => {
    const inWave = intakes.filter((i) => i.wave_id === w.id);
    const total = inWave.reduce((n, i) => n + i.tote_count, 0);
    return {
      id: w.id,
      number: w.number,
      detail:
        w.state === "draft"
          ? `Not started · ${inWave.length} ${inWave.length === 1 ? "order" : "orders"}`
          : `Checking totes · ${counts[w.id] ?? 0} of ${total}`,
    };
  });
  const open: OpenWave | null = wave
    ? {
        id: wave.id,
        number: wave.number,
        state: wave.state === "draft" ? "draft" : "verifying",
        scanned,
        expected,
        members: members.map((i) => ({
          id: i.id,
          number: i.number,
          detail: [species(i), `${i.total_incoming_lb} lb`].filter(Boolean).join(" · "),
          totes: i.tote_count,
          scanned: totes
            .filter((t) => t.wave_id === wave.id && t.intake_id === i.id)
            .map((t) => t.tote_no),
        })),
      }
    : null;
  return (
    <StationShell
      name="Wave batch"
      site={siteName}
      operator={operator}
      pending={pending}
      paused={pinOpen}
      next={refused ?? prompt.next}
      nextTone={refused ? "warn" : undefined}
      steps={WAVE_STEPS}
      step={prompt.step}
      manualLabel="Tote number (INT-0002-1)"
      status={
        <>
          <ScanFeedback feedback={feedback} idle />
          <StationNotice text={message.text} tone={message.tone} />
        </>
      }
      manual={{ ...manual, accept: ["TOTE"] }}
      onScan={(raw, _parsed, method) => {
        if (!allowed()) return;
        // Flow: a tote scanned off the wave's screen goes to the one wave being checked.
        const into = wave?.id ?? (verifying.length === 1 ? verifying[0]?.id : undefined);
        if (into && into !== wave?.id) setView({ kind: "wave", id: into });
        void scan({
          raw,
          station: "wave",
          wave_id: into,
          client_action_id: crypto.randomUUID(),
          operator_session: proof,
          entry_method: method,
        });
      }}
    >
      <WaveView
        loading={!loaded}
        queue={queueItems}
        selected={selected}
        target={{ lb: target, tolerance }}
        waves={waveTiles}
        wave={open}
        why={why}
        refused={refused !== null}
        disabled={busy || pinOpen}
        on={{
          toggle: (id) => {
            setView({ kind: "new" });
            setSelected((ids) =>
              ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id],
            );
          },
          suggest: () => setSelected(suggestWave(queue, target, tolerance).map((i) => i.id)),
          start: () => void start(),
          openWave: (id) => setView({ kind: "wave", id }),
          newWave: () => setView({ kind: "new" }),
          advance: () => void forward(),
          cancel: () => void cancel(),
        }}
      />
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
