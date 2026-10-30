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
import { BasketButton, ScaleReadout, ActionStrip } from "@/src/components/station/workbench";
import { StationShell } from "@/src/components/station/station-shell";
import { DisabledReason } from "@/src/components/station/next-step";
import { ScanFeedback } from "@/src/components/station/scan-feedback";
import { ManagerPinOverlay, OperatorPinOverlay } from "@/src/components/station/pin-overlay";
import { BAND_LABEL, NowInBlastList, useNowInBlast } from "@/components/variance/now-in-blast";
import {
  blockedIntakes,
  holdGroupFor,
  holdGroupMembers,
  useVarianceHolds,
} from "@/components/variance/use-variance-holds";
import { VarianceHoldPanel } from "./variance-hold-panel";
import { SuspectPicker, useSuspectGroup } from "./suspect-picker";
import { useOperatorIdle } from "@/src/components/station/use-operator-idle";
import { useScanAction } from "@/src/components/station/use-scan-action";
import { permanentScanFailure } from "@/src/components/station/scan-failure";
import {
  ManualEntry,
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
}): { next: string; step: number } {
  const { open, rows, selected, variance, over, held } = input;
  if (!open) return { next: "Scan a tote or tap an order", step: 0 };
  if (rows.length === 0) return { next: "Scan basket", step: 0 };
  const unweighed = rows.filter((v) => !(v.weight_lb > 0));
  if (unweighed.length) {
    // Accept / Enter weight write to the selected basket, so the line only says "Weigh" for
    // that one; otherwise it asks for the tap first. A newly added basket is selected (#97);
    // after a weight is saved the selection never moves on by itself (the scale may still hold
    // the previous basket's stable reading).
    const current = unweighed.find((v) => v.id === selected);
    const name = basketName(current ?? unweighed[0]!);
    const lower = `${name[0]!.toLowerCase()}${name.slice(1)}`;
    return { next: current ? `Weigh ${lower}` : `Tap ${lower}, then weigh it`, step: 1 };
  }
  if (held) return { next: "Check weights or get a manager sign-off", step: 2 };
  if (over && variance !== null)
    return {
      next: `Over the limit (${formatVariance(variance)}). Check weights before sending.`,
      step: 2,
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
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [weight, setWeight] = useState("");
  const scalePanel = useRef<HTMLDivElement>(null);
  const [manualOpen, setManualOpen] = useState(false);
  // "Enter manually" in the order card (#97): typing a basket number pauses the scanner.
  const [typingBasket, setTypingBasket] = useState(false);
  useEffect(() => {
    if (selected && !typingBasket && window.matchMedia?.("(max-width: 600px)").matches) {
      scalePanel.current?.scrollIntoView({ block: "center", behavior: "instant" });
    }
  }, [selected, typingBasket]);
  // Typing a sign-off note pauses the scanner like manual weight (its focus capture would
  // otherwise pull focus out of the note field).
  const [noteOpen, setNoteOpen] = useState(false);
  const [reading, setReading] = useState<number | null>(null);
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
          .select("weight_lb")
          .eq("scale_id", device.data.scale_id)
          .eq("stable", true)
          .order("read_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(1);
        if (r.error) throw new Error("Scale unavailable");
        if (version === refreshVersion.current) setReading(r.data[0]?.weight_lb ?? null);
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
      void refresh().catch(() => setMessage("Refresh unavailable; check connection."));
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
      setMessage(reply.reason);
      retry.current = null;
      if (reply.reason === "operator_pin_required") expire();
      if (reply.ok) {
        if (operation === "manual") setManualOpen(false);
        if (operation === "send") remember(null);
        if (reply.vessel_id) setSelected(reply.vessel_id);
        if (operation === "exchange") setWeight("");
      }
      await Promise.all([refresh(), holds.refresh(), blastLines.refresh()]);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Action unavailable; retry");
    } finally {
      setBusy(false);
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
      setMessage(reply?.reason ?? "Hold signed off");
      await holds.refresh();
      return { ok: true };
    } catch (e) {
      const reason = e instanceof Error ? e.message : "Sign-off unavailable; retry";
      setMessage(reason);
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
      setMessage((data as { reason?: string } | null)?.reason ?? "Done");
      await Promise.all([refresh(), holds.refresh(), blastLines.refresh(), picker.refresh()]);
      return { ok: true };
    } catch (e) {
      const reason = e instanceof Error ? e.message : "Action unavailable; retry";
      setMessage(reason);
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
  const scaleWhy =
    pickWhy ?? (reading === null || reading <= 0 ? "No reading from the scale" : null);
  const sendWhy = empty ? "Add a basket first" : sendBlocked ? "Weigh every basket first" : null;
  return (
    <StationShell
      name="Reconcile"
      className="station-tide"
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
      steps={STEPS}
      step={prompt.step}
      manualLabel="Tote number (INT-0002-1)"
      hideManual={hasOrder}
      status={
        <>
          <ScanFeedback feedback={feedback} />
          <p className="station-message" role="status">
            {busy ? "Saving…" : message}
          </p>
        </>
      }
      manual={{ ...manual, accept: ["TOTE", "TAG"] }}
      onScan={(raw, _parsed, method) => submitCode(raw, method)}
    >
      <div className="station-workspace reconcile-workspace">
        <section className="station-card reconcile-queue">
          <h2>Reconcile queue</h2>
          {intakes.map((i) => (
            <button
              key={i.id}
              aria-pressed={openId === i.id}
              disabled={disabled}
              onClick={() => remember(i.id)}
            >
              {i.number}
              {blocked.has(i.id) && (
                <>
                  {" "}
                  <span className="station-badge">HELD</span>
                </>
              )}
            </button>
          ))}
          {!intakes.length && <p>Queue empty</p>}
        </section>
        <section className="station-card reconcile-order">
          <h2>{open ? `Order ${open.number}` : "No order open"}</h2>
          {open && (
            <>
              <div className="reconcile-summary">
                <h3>Expected yield</h3>
                {open.intake_line.map((l, n) => (
                  <p key={n}>
                    {l.species_code}: {l.est_yield_lb ?? 0} lb
                  </p>
                ))}
                {empty ? (
                  <p>Expected {open.total_est_yield_lb.toFixed(2)} lb · No baskets yet</p>
                ) : (
                  <>
                    <p>
                      Actual {actual.toFixed(2)} lb · Expected {open.total_est_yield_lb.toFixed(2)}{" "}
                      lb · Variance {variance === null ? "—" : `${variance}%`}
                    </p>
                    <p className={`station-band station-band-${band}`}>
                      {BAND_LABEL[band]} (limit ±{holds.limit}%)
                      {band === "over" &&
                        !group &&
                        " — Send to Blast will be refused and held with its rollstock neighbours"}
                    </p>
                    {waiting && <p>{waiting}</p>}
                  </>
                )}
              </div>
              <div className="reconcile-bench">
                <div className="reconcile-baskets">
                  <h3>
                    Baskets <span className="station-count">{rows.length}</span>
                  </h3>
                  {empty && (
                    <p className="station-hint">Scan basket to add it — or tap Enter manually.</p>
                  )}
                  <div className="station-basket-list">
                    {rows.map((v) => (
                      <BasketButton
                        key={v.id}
                        name={basketName(v)}
                        weight={v.weight_lb}
                        manual={v.manual}
                        selected={selected === v.id}
                        disabled={disabled}
                        onClick={() => {
                          setSelected(v.id);
                          setWeight(String(v.weight_lb));
                        }}
                      />
                    ))}
                  </div>
                  <div className="station-actions station-add-basket">
                    <ManualEntry
                      open={basketTyping}
                      onOpenChange={setTypingBasket}
                      disabled={disabled || manualOpen || noteEditing || reasonEditing}
                      options={{ ...manual, accept: ["TAG"] }}
                      label="Basket number"
                      placeholder="042"
                      onSubmit={(text) => submitCode(text, "manual")}
                    />
                    <button disabled={disabled} onClick={() => void mutate("exchange")}>
                      Add exchange basket
                    </button>
                  </div>
                  <div className="reconcile-remove">
                    <button disabled={disabled || !selected} onClick={() => void mutate("remove")}>
                      Remove selected basket
                    </button>
                    <DisabledReason reason={pickWhy} />
                  </div>
                </div>
                <div className="reconcile-scale" ref={scalePanel}>
                  <ScaleReadout
                    reading={reading}
                    basket={
                      rows.find((v) => v.id === selected)
                        ? basketName(rows.find((v) => v.id === selected)!)
                        : null
                    }
                  />
                  <button
                    disabled={disabled || scaleWhy !== null}
                    onClick={() => void mutate("accept")}
                  >
                    Accept scale weight
                  </button>
                  <DisabledReason reason={scaleWhy} />
                  <button disabled={disabled || !selected} onClick={() => setManualOpen(true)}>
                    Enter weight manually
                  </button>
                  <DisabledReason reason={pickWhy} />
                  {manualOpen && (
                    <>
                      <label>
                        Manual weight (lb)
                        <input
                          autoFocus
                          type="number"
                          inputMode="decimal"
                          min="0.01"
                          step="0.01"
                          value={weight}
                          onChange={(e) => setWeight(e.target.value)}
                        />
                      </label>
                      <button
                        disabled={disabled || !selected || !(Number(weight) > 0)}
                        onClick={() => void mutate("manual")}
                      >
                        Save manual weight
                      </button>
                      <button onClick={() => setManualOpen(false)}>Cancel manual weight</button>
                    </>
                  )}
                </div>
              </div>
              <ActionStrip
                disabled={disabled || sendWhy !== null}
                reason={sendWhy}
                onSend={() => void mutate("send")}
                summary={`${rows.filter((v) => v.weight_lb > 0).length} of ${rows.length} baskets weighed`}
              />
            </>
          )}
        </section>
        {open && group && group[0]?.hold_id && (
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
        )}
        {pickerFor && (
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
        )}
        <NowInBlastList
          lines={blastLines.lines}
          error={blastLines.error}
          onSelect={(line) => setPickerFor(line.intake_id)}
        />
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
