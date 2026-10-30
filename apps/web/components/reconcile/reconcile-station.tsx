"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Database, Json } from "db";
import {
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
import { ManagerPinOverlay, OperatorPinOverlay } from "@/src/components/station/pin-overlay";
import { BAND_LABEL, NowInBlastList, useNowInBlast } from "@/components/variance/now-in-blast";
import {
  blockedIntakes,
  holdGroupFor,
  useVarianceHolds,
} from "@/components/variance/use-variance-holds";
import { VarianceHoldPanel } from "./variance-hold-panel";
import { useOperatorIdle } from "@/src/components/station/use-operator-idle";
import { useScanAction } from "@/src/components/station/use-scan-action";
import { permanentScanFailure } from "@/src/components/station/scan-failure";
import { useManualOptions, withEntryMethod } from "@/src/components/station/manual-entry";
import type { ScanRequest, ScanReply } from "@/src/components/station/scan-queue";
type SignOff = { holdId: string; reason: VarianceSignoffReason; note: string };
type Intake = Database["public"]["Tables"]["intake"]["Row"] & {
  intake_line: { species_code: string; est_yield_lb: number | null }[];
};
type Vessel = Database["public"]["Tables"]["vessel"]["Row"] & {
  asset_tag: { code: string } | null;
};
type Reply = ScanReply & { intake_id: string | null; vessel_id: string | null };
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
  const [manualOpen, setManualOpen] = useState(false);
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
  // A non-manager's sign-off waits here for the manager PIN.
  const [signOffPending, setSignOffPending] = useState<SignOff | null>(null);
  const remember = useCallback(
    (id: string | null) => {
      localStorage.setItem(scope, id ?? "");
      setOpenId(id);
      setSelected(null);
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
          ? "Scan a tote first"
          : tag && !tagAllowed
            ? "Tag belongs to another plant"
            : !parsed.ok || (parsed.value.kind !== "TOTE" && !tag)
              ? "Not a tag or tote"
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
        setSelected(reply.vessel_id);
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
  const signOff = async (request: SignOff, token?: string) => {
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
      const reply = data as { reason?: string } | null;
      setMessage(reply?.reason ?? "Hold signed off");
      await holds.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Sign-off unavailable; retry");
    } finally {
      setBusy(false);
    }
  };
  const requestSignOff = (holdId: string, reason: VarianceSignoffReason, note: string) => {
    const request = { holdId, reason, note };
    if (claims.appRole === "owner" || claims.appRole === "manager") void signOff(request);
    else setSignOffPending(request);
  };
  const blocked = blockedIntakes(holds.members);
  const group = openId ? holdGroupFor(holds.members, openId) : null;
  const open = intakes.find((i) => i.id === openId),
    rows = vessels.filter((v) => v.intake_id === openId);
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
  const disabled = busy || pending > 0 || pinOpen || signOffPending !== null;
  return (
    <StationShell
      name="Reconcile"
      site={siteName}
      operator={operator}
      pending={pending}
      paused={pinOpen || busy || manualOpen || signOffPending !== null}
      status={
        <>
          <ScanFeedback feedback={feedback} />
          <p role="status">{message}</p>
        </>
      }
      manual={{ ...manual, accept: ["TOTE", "TAG"] }}
      onScan={(raw, _parsed, method) => {
        if (!manualOpen && allowed())
          void scan({
            raw,
            station: "reconcile",
            client_action_id: crypto.randomUUID(),
            operator_session: proof,
            entry_method: method,
          });
      }}
    >
      <div className="station-workspace">
        <section className="station-card">
          <h2>Reconcile queue</h2>
          {intakes.map((i) => (
            <button key={i.id} disabled={disabled} onClick={() => remember(i.id)}>
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
        <section className="station-card">
          <h2>{open?.number ?? "Scan a tote or choose an intake"}</h2>
          {open && (
            <>
              <h3>Expected yield</h3>
              {open.intake_line.map((l, n) => (
                <p key={n}>
                  {l.species_code}: {l.est_yield_lb ?? 0} lb
                </p>
              ))}
              <p>
                Actual {actual.toFixed(2)} lb · Expected {open.total_est_yield_lb.toFixed(2)} lb ·
                Variance {variance === null ? "—" : `${variance}%`}
              </p>
              <p className={`station-band station-band-${band}`}>
                {BAND_LABEL[band]} (limit ±{holds.limit}%)
                {band === "over" &&
                  !group &&
                  " — Send to Blast will be refused and held with its rollstock neighbours"}
              </p>
              <h3>Vessels — scan tag to add</h3>
              {rows.map((v) => (
                <div key={v.id}>
                  <button
                    disabled={disabled}
                    aria-pressed={selected === v.id}
                    onClick={() => {
                      setSelected(v.id);
                      setWeight(String(v.weight_lb));
                    }}
                  >
                    {v.is_exchange ? "Exchange" : v.asset_tag?.code} · {v.weight_lb} lb{" "}
                    {v.manual && <span className="station-badge">MANUAL WEIGHT</span>}
                  </button>
                </div>
              ))}
              <button disabled={disabled} onClick={() => void mutate("exchange")}>
                Add exchange vessel (no tag)
              </button>
              <p>
                Latest stable scale:{" "}
                {reading === null ? "No reading / scale not assigned" : `${reading} lb`}
              </p>
              <button
                disabled={disabled || !selected || reading === null || reading <= 0}
                onClick={() => void mutate("accept")}
              >
                Accept scale weight
              </button>
              <button disabled={disabled || !selected} onClick={() => setManualOpen(true)}>
                Manual entry
              </button>
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
                  <button onClick={() => setManualOpen(false)}>Cancel manual entry</button>
                </>
              )}
              <button disabled={disabled || !selected} onClick={() => void mutate("remove")}>
                Remove selected vessel
              </button>
              <button disabled={disabled || sendBlocked} onClick={() => void mutate("send")}>
                Send to Blast Freezer
              </button>
            </>
          )}
        </section>
        {open && group && group[0]?.hold_id && (
          <VarianceHoldPanel
            key={group[0].hold_id}
            group={group}
            openIntakeId={open.id}
            disabled={disabled}
            onSignOff={(reason, note) => requestSignOff(group[0]!.hold_id!, reason, note)}
          />
        )}
        <NowInBlastList lines={blastLines.lines} error={blastLines.error} />
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
      {signOffPending && (
        <ManagerPinOverlay
          onClose={() => setSignOffPending(null)}
          verify={async (pin) => {
            const elevation = await managerElevation(client, pin);
            if ("reason" in elevation) return { ok: false, reason: elevation.reason };
            await signOff(signOffPending, elevation.token);
            return { ok: true };
          }}
        />
      )}
    </StationShell>
  );
}
