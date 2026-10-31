"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Database, Json } from "db";
import { hoursInCooler, parse } from "rules";
import {
  managerElevation,
  useStationSession,
  type StationSession,
} from "@/components/intake/use-station-session";
import { StationShell } from "@/src/components/station/station-shell";
import { speciesName } from "@/src/components/station/species-name";
import { ScanFeedback } from "@/src/components/station/scan-feedback";
import { StationNotice, type NoticeTone } from "@/src/components/station/notice";
import { useOnline } from "@/src/components/station/connection-chip";
import { OperatorPinOverlay, ManagerPinOverlay } from "@/src/components/station/pin-overlay";
import { useOperatorIdle } from "@/src/components/station/use-operator-idle";
import { useScanAction } from "@/src/components/station/use-scan-action";
import { useLasting } from "@/src/components/station/use-lasting";
import { permanentScanFailure } from "@/src/components/station/scan-failure";
import {
  useManualOptions,
  withEntryMethod,
  type EntryMethod,
} from "@/src/components/station/manual-entry";
import type { ScanReply, ScanRequest } from "@/src/components/station/scan-queue";
import {
  ROLLSTOCK_STEPS,
  RollstockView,
  rollstockNextStep,
  type RollstockOrder,
} from "./rollstock-view";

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
/**
 * rollstock_scan_advance refuses to move an order on before every tote is scanned, with
 * "Missing totes: X of Y scanned" (04-BUSINESS-RULES.md §5); a manager can override it.
 */
export function missingTotes(reply: ScanReply): boolean {
  return !reply.ok && reply.reason.startsWith("Missing totes");
}
/** A refusal for missing totes, kept so the manager's approval can send it again. */
type Blocked = {
  /** The open order that misses totes. */
  openId: string;
  /** The refused tote of the next order; null when Finish queue was refused. */
  raw: string | null;
  method?: EntryMethod;
  /** The order that refused tote belongs to. */
  next: string | null;
};
/** The order number a tote QR names, or null. */
function toteOrder(raw: string | null): string | null {
  if (!raw) return null;
  const parsed = parse(raw);
  return parsed.ok && parsed.value.kind === "TOTE" ? parsed.value.intakeNumber : null;
}
const species = (i: Intake) => [...new Set(i.intake_line.map((l) => speciesName(l.species_code)))];
const toteCount = (n: number) => `${n} ${n === 1 ? "tote" : "totes"}`;
/** The open order as the hero shows it: flags as badges, notes with what each is about. */
export function rollstockOrder(i: Intake, scanned: number): RollstockOrder {
  const notes: { label: string; text: string | null }[] = [
    { label: "Dirty fish", text: i.dirty_notes },
    { label: "Cut", text: i.cut_notes },
    { label: "Processing", text: i.processing_notes },
  ];
  return {
    id: i.id,
    number: i.number,
    species: species(i),
    scanned,
    totes: i.tote_count,
    flags: [
      ...(i.fast_pass ? ["FAST PASS"] : []),
      ...(i.dirty_fish ? ["DIRTY"] : []),
      ...(i.ribbing ? ["RIBBING"] : []),
    ],
    notes: notes.flatMap((n) => (n.text?.trim() ? [{ label: n.label, text: n.text }] : [])),
  };
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
  const [loaded, setLoaded] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: NoticeTone }>({
    text: "",
    tone: "info",
  });
  const [busy, setBusy] = useState(false);
  const [operator, setOperator] = useState<string | null>(
    claims.appRole === "station" ? null : "Signed-in staff",
  );
  const [proof, setProof] = useState<string | null>(null);
  const [pinOpen, setPinOpen] = useState(claims.appRole === "station");
  const [managerOpen, setManagerOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [editingReason, setEditingReason] = useState(false);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  // Refresh generations: the open order is "not found" only once a refresh started after it was
  // chosen has landed without it, so a scan that opens an order never flashes it as stale.
  const started = useRef(0);
  const [listed, setListed] = useState(0);
  const [chosen, setChosen] = useState(0);
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
      setChosen(started.current);
    },
    [scope],
  );
  const refresh = useCallback(async () => {
    const generation = ++started.current;
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
    setListed((n) => Math.max(n, generation));
    setRefreshFailed(false);
  }, [client]);
  useEffect(() => {
    const syncOpen = () => {
      setOpenId(localStorage.getItem(scope) || null);
      setChosen(started.current);
    };
    syncOpen();
    const storageChanged = (event: StorageEvent) => {
      if (event.storageArea === localStorage && (event.key === scope || event.key === null))
        syncOpen();
    };
    window.addEventListener("storage", storageChanged);
    const reload = () => {
      void refresh()
        .catch(() => setRefreshFailed(true))
        .finally(() => setLoaded(true));
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
      const current = localStorage.getItem(scope) || null;
      const { data, error } = await withEntryMethod(
        client.rpc("rollstock_scan_advance", {
          p_raw: request.raw,
          p_open_intake_id: current!,
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
      // The next order's tote, refused for missing totes: the manager path opens with it and stays
      // while that order is open (its own totes count down as they come in).
      if (missingTotes(reply) && current)
        setBlocked({
          openId: current,
          raw: request.raw,
          method: request.entry_method,
          next: toteOrder(request.raw),
        });
      if (reply.reason === "operator_pin_required") expire();
      void refresh().catch(() => undefined);
      return reply;
    },
    [client, expire, refresh, remember, scope],
  );
  const { scan, pending, feedback } = useScanAction(scope, send);
  const manual = useManualOptions(client, claims.orgId);
  const online = useOnline();
  const allowed = () => {
    if (claims.appRole === "station" && (!operator || idle.check())) {
      setPinOpen(true);
      return false;
    }
    return true;
  };
  /** Finish queue; with `approval`, the manager's override of missing totes. */
  const finish = async (approval?: { token?: string }) => {
    if (!allowed() || pending || busy) return;
    setBusy(true);
    try {
      await navigator.locks.request(`scan-delivery:${scope}`, async () => {
        const current = localStorage.getItem(scope) || null;
        const number = intakes.find((i) => i.id === current)?.number;
        // An approval sends the refused tote again, so the next order opens in the same step.
        const raw = (approval && blocked?.openId === current && blocked.raw) || null;
        const { data, error } = await withEntryMethod(
          client.rpc("rollstock_scan_advance", {
            p_raw: raw!,
            p_open_intake_id: current!,
            p_client_action_id: crypto.randomUUID(),
            p_operator_session: proof ?? undefined,
            p_override_reason: approval ? overrideReason : undefined,
            p_elevation_token: approval?.token,
          }),
          raw ? blocked?.method : undefined,
        );
        if (error) throw new Error(error.message);
        const reply = rollstockReply(data);
        remember(reply.open_intake_id);
        if (reply.ok) {
          const opened = raw && reply.open_intake_id ? toteOrder(raw) : null;
          setMessage({
            text: `${number ? `Order ${number}` : "Order"} sent to reconcile${opened ? `; ${opened} is open` : ""}`,
            tone: "ok",
          });
          setBlocked(null);
          setOverrideReason("");
        } else {
          if (missingTotes(reply) && current && !approval)
            setBlocked({ openId: current, raw: null, next: null });
          setMessage({ text: reply.reason, tone: "error" });
        }
        if (reply.reason === "operator_pin_required") expire();
      });
      await refresh();
    } catch (error) {
      setMessage({
        text: error instanceof Error ? error.message : "Finish unavailable",
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };
  const approve = () => {
    if (!allowed()) return;
    // A manager account approves directly; anyone else needs a manager PIN.
    if (claims.appRole === "owner" || claims.appRole === "manager") void finish({});
    else setManagerOpen(true);
  };
  const selectOpen = async (id: string | null) => {
    await navigator.locks.request(`scan-delivery:${scope}`, () => remember(id));
  };
  // The server's reply says which order is open; the list may not have caught up with its state.
  const open = intakes.find((i) => i.id === openId);
  const stale = Boolean(openId && !open && listed > chosen);
  const order = open ? rollstockOrder(open, counts[open.id] ?? 0) : null;
  const block =
    order && blocked?.openId === order.id ? { next: blocked.raw ? blocked.next : null } : null;
  // The order whose Missing totes panel is on screen (the view shows it only while totes are
  // missing). The reason, and its editing mode, belong to that panel: when it goes (missing tote
  // scanned, another order resumed, the order moved on elsewhere) they go too, so the scanner and
  // Enter manually are never left paused behind a field that is no longer there.
  const panelFor =
    order && block && !(order.scanned >= order.totes && order.totes > 0) ? order.id : null;
  const [reasonFor, setReasonFor] = useState(panelFor);
  if (reasonFor !== panelFor) {
    setReasonFor(panelFor);
    setEditingReason(false);
    setOverrideReason("");
  }
  const editing = editingReason && panelFor !== null;
  const nextUp = intakes.filter((i) => i.state !== "rollstock" && i.id !== openId);
  const now = new Date();
  const prompt = rollstockNextStep(order, block, nextUp.length, stale);
  // Taps wait while scans are sending; the reason shows only once they stay pending, so a quick
  // round trip never flashes it (the buttons themselves grey out after 200 ms, docs/12).
  const waiting = useLasting(pending > 0, 600);
  return (
    <StationShell
      name="Rollstock"
      site={siteName}
      operator={operator}
      pending={pending}
      paused={pinOpen || managerOpen || busy || editing}
      next={prompt.next}
      nextTone={prompt.tone}
      steps={ROLLSTOCK_STEPS}
      step={prompt.step}
      manualLabel="Tote number (INT-0002-1)"
      status={
        <>
          <ScanFeedback feedback={feedback} idle />
          <StationNotice
            text={refreshFailed ? "Refresh unavailable; check connection." : message.text}
            tone={refreshFailed ? "error" : message.tone}
          />
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
      <RollstockView
        loading={!loaded}
        order={order}
        stale={stale}
        nextUp={nextUp.map((i) => ({
          id: i.id,
          number: i.number,
          detail: [
            species(i).join(", "),
            toteCount(i.tote_count),
            i.state === "holding" ? "Cooler bypass" : "Processing",
          ]
            .filter(Boolean)
            .join(" · "),
          age: `${hoursInCooler(new Date(i.intake_at), now)}h since drop-off`,
          flags: rollstockOrder(i, 0).flags,
        }))}
        resume={intakes
          .filter((i) => i.state === "rollstock" && i.id !== openId)
          .map((i) => ({ id: i.id, number: i.number }))}
        blocked={block}
        reason={overrideReason}
        editingReason={editing}
        sending={waiting ? "Waiting for scans to send" : pending > 0 ? "" : null}
        online={online}
        busy={busy || pinOpen || managerOpen}
        on={{
          finish: () => void finish(),
          resume: (id) => void selectOpen(id),
          clearStale: () => void selectOpen(null),
          editReason: setEditingReason,
          reasonChange: setOverrideReason,
          approve,
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
      {managerOpen && (
        <ManagerPinOverlay
          onClose={() => setManagerOpen(false)}
          verify={async (pin) => {
            const elevation = await managerElevation(client, pin);
            if ("reason" in elevation) return { ok: false, reason: elevation.reason };
            await finish({ token: elevation.token });
            return { ok: true };
          }}
        />
      )}
    </StationShell>
  );
}
