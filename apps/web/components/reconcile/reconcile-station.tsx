"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Database, Json } from "db";
import {
  formatVariance,
  holdWaitingMessage,
  holdWaitingOn,
  parse,
  variancePercent,
  varianceBand,
  sendToBlastBlockers,
  type VarianceSignoffReason,
} from "rules";
import {
  managerElevation,
  useStationSession,
  type StationSession,
} from "@/components/intake/use-station-session";
import { StationShell } from "@/src/components/station/station-shell";
import { ScanFeedback } from "@/src/components/station/scan-feedback";
import { StationNotice, type NoticeTone } from "@/src/components/station/notice";
import { ageBadge } from "@/src/components/station/queue-list";
import type { ScaleState } from "@/src/components/station/scale-readout";
import { ManagerPinOverlay, OperatorPinOverlay } from "@/src/components/station/pin-overlay";
import { NowInBlastList, useNowInBlast } from "@/components/variance/now-in-blast";
import {
  blockedIntakes,
  holdGroupFor,
  holdGroupMembers,
  useVarianceHolds,
} from "@/components/variance/use-variance-holds";
import { VarianceHoldPanel } from "./variance-hold-panel";
import { SuspectPicker, useSuspectGroup } from "./suspect-picker";
import { ReconcileView, speciesName } from "./reconcile-view";
import { useOperatorIdle } from "@/src/components/station/use-operator-idle";
import { useScanAction } from "@/src/components/station/use-scan-action";
import { permanentScanFailure } from "@/src/components/station/scan-failure";
import {
  useManualOptions,
  withEntryMethod,
  type EntryMethod,
} from "@/src/components/station/manual-entry";
import type { ScanRequest, ScanReply } from "@/src/components/station/scan-queue";
type SignOff = { holdId: string; reason: VarianceSignoffReason; note: string };
/** A manager action: run directly by a manager account, or with a manager PIN elevation token. */
type ManagerAction = (token?: string) => Promise<{ ok: boolean; reason?: string }>;
type RpcReply = PromiseLike<{ data: unknown; error: { message: string } | null }>;
type Intake = Database["public"]["Tables"]["intake"]["Row"] & {
  intake_line: { species_code: string; est_yield_lb: number | null }[];
};
type Vessel = Database["public"]["Tables"]["vessel"]["Row"] & {
  asset_tag: { code: string } | null;
};
type Reply = ScanReply & { intake_id: string | null; vessel_id: string | null };
const STEPS = ["Add baskets", "Weigh", "Send to Blast"] as const;
type BasketRow = Pick<Vessel, "id" | "weight_lb" | "is_exchange" | "asset_tag">;
/** "Basket 005" / "Exchange basket" (docs/11-FLOOR-WORDING.md). */
export function basketName(v: Pick<Vessel, "is_exchange" | "asset_tag">): string {
  return v.is_exchange || !v.asset_tag ? "Exchange basket" : `Basket ${v.asset_tag.code}`;
}
/**
 * The next step line and current step (docs/11-FLOOR-WORDING.md, Reconcile): scan a tote or tap
 * an order → scan basket → weigh basket 005 → send to blast (or check weights over the limit).
 */
export function reconcileNextStep(input: {
  open: boolean;
  rows: readonly BasketRow[];
  selected: string | null;
  variance: number | null;
  over: boolean;
  held: boolean;
}): { next: string; step: number; tone?: "warn" } {
  const { open, rows, selected, variance, over, held } = input;
  if (!open) return { next: "Scan a tote or tap an order", step: 0 };
  if (rows.length === 0) return { next: "Scan basket", step: 0 };
  const unweighed = rows.filter((v) => !(v.weight_lb > 0));
  if (unweighed.length) {
    // Accept / Enter weight write to the selected basket, so the line only says "Weigh" for
    // that one; otherwise it asks for the tap first. A newly added basket is selected (#97).
    // After a typed weight the selection stays put; after Accept it moves to the next unweighed
    // basket, and Accept waits for a new stable reading (the scale still holds the last one).
    const current = unweighed.find((v) => v.id === selected);
    const name = basketName(current ?? unweighed[0]!);
    const lower = `${name[0]!.toLowerCase()}${name.slice(1)}`;
    return { next: current ? `Weigh ${lower}` : `Tap ${lower}, then weigh it`, step: 1 };
  }
  if (held) return { next: "Check weights or get a manager sign-off", step: 2, tone: "warn" };
  if (over && variance !== null)
    return {
      next: `Over the limit (${formatVariance(variance)}). Check weights before sending.`,
      step: 2,
      tone: "warn",
    };
  return { next: "Send to Blast", step: 2 };
}
export function reconcileReply(data: Json): Reply {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    typeof data.ok !== "boolean" ||
    typeof data.reason !== "string"
  )
    throw new Error("Invalid reconcile reply");
  return data as Reply;
}
export function ReconcileStation() {
  const { session, loaded } = useStationSession();
  if (!loaded) return <main className="station">Opening reconcile…</main>;
  if (!session)
    return (
      <main className="station">
        <h1>Reconcile</h1>
        <a href="/login">Sign in</a> or <a href="/pair">pair device</a>
      </main>
    );
  return <LiveReconcile {...session} />;
}
function LiveReconcile({ client, claims, siteName }: StationSession) {
  const scope = `${claims.orgId}:${claims.userId}:reconcile`;
  const [intakes, setIntakes] = useState<Intake[]>([]),
    [vessels, setVessels] = useState<Vessel[]>([]);
  const [openId, setOpenId] = useState<string | null>(() =>
      typeof window === "undefined" ? null : localStorage.getItem(scope) || null,
    ),
    [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: NoticeTone }>({
      text: "",
      tone: "info",
    }),
    [busy, setBusy] = useState(false),
    [weight, setWeight] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  // "Enter manually" in the order card (#97): typing a basket number pauses the scanner.
  const [typingBasket, setTypingBasket] = useState(false);
  // Typing a sign-off note pauses the scanner like manual weight (its focus capture would
  // otherwise pull focus out of the note field).
  const [noteOpen, setNoteOpen] = useState(false);
  // The latest stable reading, and the one Accept last wrote (it may not be written twice).
  const [reading, setReading] = useState<{ id: string; lb: number } | null>(null);
  const [usedReading, setUsedReading] = useState<string | null>(null);
  // First load back (placeholders until then); a weight on its way (shown at once).
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState<{ id: string; lb: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const [pinOpen, setPinOpen] = useState(claims.appRole === "station"),
    [proof, setProof] = useState<string | null>(null);
  const [operator, setOperator] = useState<string | null>(
    claims.appRole === "station" ? null : "Signed-in staff",
  );
  const expire = useCallback(() => {
    setOperator(null);
    setProof(null);
    setPinOpen(true);
  }, []);
  const idle = useOperatorIdle(claims.appRole === "station" && operator !== null, expire);
  const holds = useVarianceHolds(client, claims.orgId, scope);
  const blastLines = useNowInBlast(client, claims.orgId, scope);
  // A non-manager's sign-off, bin move or pull back waits here for the manager PIN.
  const [managerPending, setManagerPending] = useState<ManagerAction | null>(null);
  // The suspect picker (#88), centred on a held intake or a tapped "now in blast" line. Typing a
  // pull-back reason pauses the scanner like the sign-off note.
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const picker = useSuspectGroup(client, pickerFor);
  const remember = useCallback(
    (id: string | null) => {
      localStorage.setItem(scope, id ?? "");
      setOpenId(id);
      setSelected(null);
      setNoteOpen(false);
    },
    [scope],
  );
  const refreshVersion = useRef(0);
  const invalidateRefresh = useCallback(() => {
    ++refreshVersion.current;
  }, []);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    const [is, vs] = await Promise.all([
      client
        .from("intake")
        .select("*,intake_line(species_code,est_yield_lb)")
        .eq("state", "reconcile")
        .order("rollstock_done_at")
        .order("id"),
      openId
        ? client
            .from("vessel")
            .select("*,asset_tag!vessel_asset_tag_id_fkey(code)")
            .eq("intake_id", openId)
            .eq("lifecycle_state", "occupied")
            .order("id")
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (is.error || vs.error) throw new Error("Reconcile refresh unavailable");
    if (version !== refreshVersion.current) return;
    setIntakes(is.data ?? []);
    setVessels(vs.data ?? []);
    if (claims.deviceId) {
      const device = await client
        .from("device")
        .select("scale_id")
        .eq("id", claims.deviceId)
        .single();
      if (device.error) throw new Error("Device scale unavailable");
      if (device.data.scale_id) {
        const r = await client
          .from("scale_reading")
          .select("id,weight_lb")
          .eq("scale_id", device.data.scale_id)
          .eq("stable", true)
          .order("read_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(1);
        if (r.error) throw new Error("Scale unavailable");
        const latest = r.data[0];
        if (version === refreshVersion.current)
          setReading(latest ? { id: latest.id, lb: latest.weight_lb } : null);
      }
    }
  }, [client, claims.deviceId, openId]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === scope) {
        setOpenId(localStorage.getItem(scope) || null);
        setSelected(null);
      }
    };
    window.addEventListener("storage", sync);
    const reload = () => {
      void refresh()
        .catch(() => setMessage({ text: "Refresh unavailable; check connection.", tone: "error" }))
        .finally(() => setLoaded(true));
    };
    reload();
    const channel = client.channel(scope);
    for (const table of ["intake", "vessel", "scale_reading"])
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: `org_id=eq.${claims.orgId}` },
        reload,
      );
    channel.subscribe();
    const timer = setInterval(reload, 15000);
    return () => {
      invalidateRefresh();
      window.removeEventListener("storage", sync);
      clearInterval(timer);
      void client.removeChannel(channel);
    };
  }, [client, claims.orgId, refresh, scope, invalidateRefresh]);
  const send = useCallback(
    async (request: ScanRequest): Promise<ScanReply> => {
      const parsed = parse(request.raw);
      const tag = parsed.ok && parsed.value.kind === "TAG" ? parsed.value : null;
      const org = tag?.orgSlug
        ? await client.from("org").select("slug").eq("id", claims.orgId).single()
        : null;
      const tagAllowed = tag && (!tag.orgSlug || tag.orgSlug === org?.data?.slug);
      const current = localStorage.getItem(scope) || null;
      const rejection =
        tag && !current
          ? "Scan a tote or tap an order first"
          : tag && !tagAllowed
            ? "This basket belongs to another plant. Scan a different basket."
            : !parsed.ok || (parsed.value.kind !== "TOTE" && !tag)
              ? "Not a basket or a tote. Scan a basket or a tote."
              : null;
      if (rejection) {
        const { data, error } = await withEntryMethod(
          client.rpc("station_scan", {
            p_client_action_id: request.client_action_id,
            p_station: "reconcile",
            p_raw: request.raw,
            p_parsed: parsed.ok ? parsed.value : null,
            p_reason: rejection,
            p_operator_session: request.operator_session ?? undefined,
          }),
          request.entry_method,
        );
        if (error) {
          const permanent = permanentScanFailure(error);
          if (permanent) return permanent;
          throw new Error("Scan audit unavailable");
        }
        const reply = reconcileReply(data);
        if (reply.reason === "operator_pin_required") expire();
        return reply;
      }
      const { data, error } = await withEntryMethod(
        client.rpc("reconcile_action", {
          p_client_action_id: request.client_action_id,
          p_intake_id: current ?? undefined,
          p_operation: tagAllowed
            ? "bind"
            : parsed.ok && parsed.value.kind === "TOTE"
              ? "open"
              : "reject",
          p_code: tagAllowed ? tag.code : undefined,
          p_raw: request.raw,
          p_parsed: parsed.ok ? parsed.value : null,
          p_operator_session: request.operator_session ?? undefined,
        }),
        request.entry_method,
      );
      if (error) {
        const permanent = permanentScanFailure(error);
        if (permanent) return permanent;
        throw new Error("Scan delivery unavailable");
      }
      const reply = reconcileReply(data);
      if (reply.ok && reply.intake_id) {
        remember(reply.intake_id);
        // A scanned or typed basket is selected straight away, ready to weigh (#97).
        setSelected(reply.vessel_id);
        if (reply.vessel_id) setWeight("");
      }
      if (reply.reason === "operator_pin_required") expire();
      await refresh();
      return reply;
    },
    [client, claims.orgId, scope, remember, expire, refresh],
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
  const submitCode = (raw: string, method: EntryMethod) => {
    if (!manualOpen && !noteEditing && !reasonEditing && allowed())
      void scan({
        raw,
        station: "reconcile",
        client_action_id: crypto.randomUUID(),
        operator_session: proof,
        entry_method: method,
      });
  };
  // Preserve a failed request's key, including its inputs, for a safe retry after a lost response.
  const retry = useRef<{ signature: string; id: string } | null>(null);
  const mutate = async (operation: string) => {
    if (!allowed() || busy || pending || !openId) return;
    setBusy(true);
    const target = selected;
    // Optimistic: the weight shows on its basket in the same frame as the tap.
    if (target && operation === "accept" && reading) setSaving({ id: target, lb: reading.lb });
    if (target && operation === "manual") setSaving({ id: target, lb: Number(weight) });
    const signature = JSON.stringify([operation, openId, selected, weight]);
    if (retry.current?.signature !== signature)
      retry.current = { signature, id: crypto.randomUUID() };
    try {
      const { data, error } = await client.rpc("reconcile_action", {
        p_client_action_id: retry.current.id,
        p_intake_id: openId,
        p_operation: operation,
        p_vessel_id: selected ?? undefined,
        p_weight: operation === "manual" ? Number(weight) : undefined,
        p_operator_session: proof ?? undefined,
      });
      if (error) throw new Error(error.message);
      const reply = reconcileReply(data);
      setMessage({ text: reply.reason, tone: reply.ok ? "ok" : "error" });
      retry.current = null;
      if (reply.reason === "operator_pin_required") expire();
      if (reply.ok) {
        if (operation === "manual") setManualOpen(false);
        if (operation === "send") remember(null);
        if (reply.vessel_id) setSelected(reply.vessel_id);
        if (operation === "exchange") setWeight("");
        if (operation === "accept") {
          // Auto-advance: the next unweighed basket is selected, and Accept waits for a new
          // stable reading so this one is never written to two baskets. The reading shown is
          // held as used until the refresh brings the one written (readingUsed).
          if (reading) setUsedReading(reading.id);
          const following = rows.find((v) => v.id !== target && !(v.weight_lb > 0));
          if (following) {
            setSelected(following.id);
            setWeight("");
          }
        }
      }
      await Promise.all([refresh(), holds.refresh(), blastLines.refresh()]);
    } catch (e) {
      setMessage({
        text: e instanceof Error ? e.message : "Action unavailable; retry",
        tone: "error",
      });
    } finally {
      setBusy(false);
      setSaving(null);
    }
  };
  // Same key for a retried sign-off after a lost response; the token is proof, not identity.
  const signOffRetry = useRef<{ signature: string; id: string } | null>(null);
  // Resolves with the outcome so the manager PIN overlay closes only on a real sign-off.
  const signOff = async (
    request: SignOff,
    token?: string,
  ): Promise<{ ok: boolean; reason?: string }> => {
    setBusy(true);
    const signature = JSON.stringify([request.holdId, request.reason, request.note]);
    if (signOffRetry.current?.signature !== signature)
      signOffRetry.current = { signature, id: crypto.randomUUID() };
    try {
      const { data, error } = await client.rpc("variance_hold_signoff", {
        p_client_action_id: signOffRetry.current.id,
        p_hold_id: request.holdId,
        p_reason: request.reason,
        p_note: request.note || undefined,
        p_elevation_token: token,
      });
      if (error) throw new Error(error.message);
      signOffRetry.current = null;
      setNoteOpen(false);
      const reply = data as { reason?: string } | null;
      setMessage({ text: reply?.reason ?? "Hold signed off", tone: "ok" });
      await holds.refresh();
      return { ok: true };
    } catch (e) {
      const reason = e instanceof Error ? e.message : "Sign-off unavailable; retry";
      setMessage({ text: reason, tone: "error" });
      return { ok: false, reason };
    } finally {
      setBusy(false);
    }
  };
  const asManager = (action: ManagerAction) => {
    if (claims.appRole === "owner" || claims.appRole === "manager") void action();
    else setManagerPending(() => action);
  };
  const requestSignOff = (holdId: string, reason: VarianceSignoffReason, note: string) =>
    asManager((token) => signOff({ holdId, reason, note }, token));
  // Same key for a retried move or pull back after a lost response, as for the sign-off.
  const managedRetry = useRef<{ signature: string; id: string } | null>(null);
  const runManaged = async (
    signature: string,
    call: (clientActionId: string, token?: string) => RpcReply,
    token?: string,
  ): Promise<{ ok: boolean; reason?: string }> => {
    setBusy(true);
    if (managedRetry.current?.signature !== signature)
      managedRetry.current = { signature, id: crypto.randomUUID() };
    try {
      const { data, error } = await call(managedRetry.current.id, token);
      if (error) throw new Error(error.message);
      managedRetry.current = null;
      setMessage({ text: (data as { reason?: string } | null)?.reason ?? "Done", tone: "ok" });
      await Promise.all([refresh(), holds.refresh(), blastLines.refresh(), picker.refresh()]);
      return { ok: true };
    } catch (e) {
      const reason = e instanceof Error ? e.message : "Action unavailable; retry";
      setMessage({ text: reason, tone: "error" });
      return { ok: false, reason };
    } finally {
      setBusy(false);
    }
  };
  const moveBin = (vesselId: string, toIntakeId: string, centerIntakeId: string) =>
    asManager((token) =>
      runManaged(
        JSON.stringify(["move", vesselId, toIntakeId, centerIntakeId]),
        (id, t) =>
          client.rpc("variance_move_vessel", {
            p_client_action_id: id,
            p_vessel_id: vesselId,
            p_to_intake_id: toIntakeId,
            p_center_intake_id: centerIntakeId,
            p_elevation_token: t,
          }),
        token,
      ),
    );
  const pullBack = (intakeId: string, reason: string) => {
    setReasonOpen(false);
    asManager((token) =>
      runManaged(
        JSON.stringify(["pull_back", intakeId, reason]),
        (id, t) =>
          client.rpc("intake_pull_back", {
            p_client_action_id: id,
            p_intake_id: intakeId,
            p_reason: reason,
            p_elevation_token: t,
          }),
        token,
      ),
    );
  };
  // Keep the picker's group current as the floor changes (holds, intakes, blast lines).
  const refreshPicker = picker.refresh;
  useEffect(() => {
    void refreshPicker();
  }, [refreshPicker, intakes, holds.members, blastLines.lines]);
  const blocked = blockedIntakes(holds.members);
  const group = openId ? holdGroupFor(holds.members, openId) : null;
  const noteEditing = noteOpen && group !== null;
  const open = intakes.find((i) => i.id === openId),
    rows = vessels.filter((v) => v.intake_id === openId);
  // The basket field lives in the order card: with no order open it is closed, not hidden open.
  const hasOrder = open !== undefined;
  const [hadOrder, setHadOrder] = useState(hasOrder);
  if (hadOrder !== hasOrder) {
    setHadOrder(hasOrder);
    if (!hasOrder) setTypingBasket(false);
  }
  const basketTyping = typingBasket && hasOrder;
  const actual = rows.reduce((sum, v) => sum + v.weight_lb, 0),
    variance = variancePercent(actual, open?.total_est_yield_lb ?? 0),
    band = varianceBand(actual, open?.total_est_yield_lb ?? 0, holds.limit);
  const sendBlocked =
    sendToBlastBlockers(
      rows.map((v) => ({
        weightLb: v.weight_lb,
        isExchange: v.is_exchange,
        assetTagId: v.asset_tag_id,
      })),
    ).length > 0;
  const reasonEditing = reasonOpen && pickerFor !== null;
  const disabled = busy || pending > 0 || pinOpen || managerPending !== null;
  const prompt = reconcileNextStep({
    open: open !== undefined,
    rows,
    selected,
    variance,
    over: band === "over",
    held: group !== null,
  });
  // No verdict without data (docs/11-FLOOR-WORDING.md): no variance, band or warning until the
  // order has a basket.
  const empty = rows.length === 0;
  // The open order's own hold, though it is no longer over the limit: what the hold waits on, as
  // the Send to Blast refusal will say (#93; rules: holdWaitingOn / holdWaitingMessage).
  const waiting =
    open && group?.some((m) => m.position === 0 && m.intake_id === open.id)
      ? holdWaitingMessage(open.number, band, holdWaitingOn(holdGroupMembers(group), open.id))
      : null;
  const pickWhy = empty ? "Add a basket first" : !selected ? "Tap a basket first" : null;
  // Accept writes the latest stable reading; one already written waits for a new one. The server
  // picks that reading itself, so it may be newer than the one shown when Accept was tapped: the
  // reading actually written is the one on a basket (vessel.scale_reading_id, after the refresh).
  // The one shown is held as used until then.
  const readingUsed =
    reading !== null &&
    (reading.id === usedReading || rows.some((v) => v.scale_reading_id === reading.id));
  const scaleState: ScaleState =
    reading === null || reading.lb <= 0 ? "none" : readingUsed ? "used" : "stable";
  const scaleWhy =
    pickWhy ??
    (scaleState === "none"
      ? "No reading from the scale"
      : scaleState === "used"
        ? "Put the basket on the scale for a new reading"
        : null);
  const sendWhy = empty ? "Add a basket first" : sendBlocked ? "Weigh every basket first" : null;
  return (
    <StationShell
      name="Reconcile"
      site={siteName}
      operator={operator}
      pending={pending}
      paused={
        pinOpen ||
        busy ||
        manualOpen ||
        basketTyping ||
        noteEditing ||
        reasonEditing ||
        managerPending !== null
      }
      next={prompt.next}
      nextTone={prompt.tone}
      steps={STEPS}
      step={prompt.step}
      manualLabel="Tote number (INT-0002-1)"
      hideManual={hasOrder}
      status={
        <>
          <ScanFeedback feedback={feedback} idle />
          <StationNotice text={message.text} tone={message.tone} />
        </>
      }
      manual={{ ...manual, accept: ["TOTE", "TAG"] }}
      onScan={(raw, _parsed, method) => submitCode(raw, method)}
    >
      <ReconcileView
        loading={!loaded}
        queue={intakes.map((i) => ({
          id: i.id,
          number: i.number,
          held: blocked.has(i.id),
          detail: [
            [...new Set(i.intake_line.map((l) => speciesName(l.species_code)))].join(", "),
            `${i.total_est_yield_lb} lb expected`,
          ]
            .filter(Boolean)
            .join(" · "),
          age: i.rollstock_done_at ? ageBadge(i.rollstock_done_at, now) : "",
        }))}
        order={
          open
            ? {
                id: open.id,
                number: open.number,
                lines: open.intake_line.map((l) => ({
                  species: l.species_code,
                  lb: l.est_yield_lb ?? 0,
                })),
                expectedLb: open.total_est_yield_lb,
              }
            : null
        }
        baskets={rows.map((v) => ({
          id: v.id,
          code: v.asset_tag?.code ?? null,
          exchange: v.is_exchange,
          weightLb: v.weight_lb,
          manual: v.manual,
        }))}
        selected={selected}
        saving={saving}
        variance={{
          actualLb: actual,
          pct: variance,
          band,
          limitPct: holds.limit,
          refusal: band === "over" && !group,
          waiting,
        }}
        scale={{ reading: reading?.lb ?? null, state: scaleState }}
        manualWeight={{ open: manualOpen, value: weight }}
        why={{ pick: pickWhy, scale: scaleWhy, send: sendWhy }}
        disabled={disabled}
        basketField={{
          open: basketTyping,
          disabled: disabled || manualOpen || noteEditing || reasonEditing,
          options: { ...manual, accept: ["TAG"] },
        }}
        holdPanel={
          open &&
          group &&
          group[0]?.hold_id && (
            <VarianceHoldPanel
              key={group[0].hold_id}
              group={group}
              openIntakeId={open.id}
              disabled={disabled}
              editingNote={noteEditing}
              onEditNote={setNoteOpen}
              onSignOff={(reason, note) => requestSignOff(group[0]!.hold_id!, reason, note)}
              onFindSuspects={() => setPickerFor(open.id)}
            />
          )
        }
        suspectKey={pickerFor}
        suspectPicker={
          pickerFor && (
            <SuspectPicker
              key={pickerFor}
              rows={picker.rows}
              bins={picker.bins}
              error={picker.error}
              disabled={disabled}
              editingReason={reasonEditing}
              onEditReason={setReasonOpen}
              onMove={moveBin}
              onPullBack={pullBack}
              onClose={() => {
                setReasonOpen(false);
                setPickerFor(null);
              }}
            />
          )
        }
        blastList={
          <NowInBlastList
            lines={blastLines.lines}
            error={blastLines.error}
            onSelect={(line) => setPickerFor(line.intake_id)}
          />
        }
        on={{
          openOrder: (id) => remember(id),
          selectBasket: (id) => {
            const v = rows.find((r) => r.id === id);
            setSelected(id);
            setWeight(String(v?.weight_lb ?? ""));
          },
          basketField: setTypingBasket,
          submitBasket: (text) => submitCode(text, "manual"),
          addExchange: () => void mutate("exchange"),
          accept: () => void mutate("accept"),
          manualWeight: setManualOpen,
          weightChange: setWeight,
          saveManual: () => {
            if (selected && Number(weight) > 0) void mutate("manual");
          },
          remove: () => void mutate("remove"),
          send: () => void mutate("send"),
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
            setProof(r.session_id);
            setOperator(r.member?.display_name ?? "Operator");
            idle.reset();
            return { ok: true };
          }}
        />
      )}
      {managerPending && (
        <ManagerPinOverlay
          onClose={() => setManagerPending(null)}
          verify={async (pin) => {
            const elevation = await managerElevation(client, pin);
            if ("reason" in elevation) return { ok: false, reason: elevation.reason };
            return managerPending(elevation.token);
          }}
        />
      )}
    </StationShell>
  );
}
