"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Database, Json } from "db";
import { parse, variancePercent } from "rules";
import { useStationSession, type StationSession } from "@/components/intake/use-station-session";
import { StationShell } from "@/src/components/station/station-shell";
import { ScanFeedback } from "@/src/components/station/scan-feedback";
import { OperatorPinOverlay } from "@/src/components/station/pin-overlay";
import { useOperatorIdle } from "@/src/components/station/use-operator-idle";
import { useScanAction } from "@/src/components/station/use-scan-action";
import { permanentScanFailure } from "@/src/components/station/scan-failure";
import type { ScanRequest, ScanReply } from "@/src/components/station/scan-queue";
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
  const remember = useCallback(
    (id: string | null) => {
      localStorage.setItem(scope, id ?? "");
      setOpenId(id);
      setSelected(null);
    },
    [scope],
  );
  const refresh = useCallback(async () => {
    const [is, vs] = await Promise.all([
      client
        .from("intake")
        .select("*,intake_line(species_code,est_yield_lb)")
        .eq("state", "reconcile")
        .order("rollstock_done_at")
        .order("id"),
      client.from("vessel").select("*,asset_tag(code)").eq("lifecycle_state", "occupied"),
    ]);
    if (is.error || vs.error) throw new Error("Reconcile refresh unavailable");
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
        setReading(r.data[0]?.weight_lb ?? null);
      }
    }
  }, [client, claims.deviceId]);
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
      window.removeEventListener("storage", sync);
      clearInterval(timer);
      void client.removeChannel(channel);
    };
  }, [client, claims.orgId, refresh, scope]);
  const send = useCallback(
    async (request: ScanRequest): Promise<ScanReply> => {
      const parsed = parse(request.raw);
      const tag = parsed.ok && parsed.value.kind === "TAG" ? parsed.value : null;
      const org = tag?.orgSlug
        ? await client.from("org").select("slug").eq("id", claims.orgId).single()
        : null;
      const tagAllowed = tag && (!tag.orgSlug || tag.orgSlug === org?.data?.slug);
      const current = localStorage.getItem(scope) || null;
      const { data, error } = await client.rpc("reconcile_action", {
        p_client_action_id: request.client_action_id,
        p_intake_id: current!,
        p_operation: tagAllowed
          ? "bind"
          : parsed.ok && parsed.value.kind === "TOTE"
            ? "open"
            : "reject",
        p_code: tagAllowed ? tag.code : undefined,
        p_raw: request.raw,
        p_parsed: parsed.ok ? parsed.value : null,
        p_operator_session: request.operator_session ?? undefined,
      });
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
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Action unavailable; retry");
    } finally {
      setBusy(false);
    }
  };
  const open = intakes.find((i) => i.id === openId),
    rows = vessels.filter((v) => v.intake_id === openId);
  const actual = rows.reduce((sum, v) => sum + v.weight_lb, 0),
    variance = variancePercent(actual, open?.total_est_yield_lb ?? 0);
  const disabled = busy || pending > 0 || pinOpen;
  return (
    <StationShell
      name="Reconcile"
      site={siteName}
      operator={operator}
      pending={pending}
      paused={pinOpen || busy || manualOpen}
      status={
        <>
          <ScanFeedback feedback={feedback} />
          <p role="status">{message}</p>
        </>
      }
      onScan={(raw) => {
        if (!manualOpen && allowed())
          void scan({
            raw,
            station: "reconcile",
            client_action_id: crypto.randomUUID(),
            operator_session: proof,
          });
      }}
    >
      <div className="station-workspace">
        <section className="station-card">
          <h2>Reconcile queue</h2>
          {intakes.map((i) => (
            <button key={i.id} disabled={disabled} onClick={() => remember(i.id)}>
              {i.number}
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
                    {v.manual && "(manual)"}
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
              <button
                disabled={
                  disabled ||
                  !rows.length ||
                  rows.some((v) => v.weight_lb <= 0 || (!v.is_exchange && !v.asset_tag_id))
                }
                onClick={() => void mutate("send")}
              >
                Send to Blast Freezer
              </button>
            </>
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
            setProof(r.session_id);
            setOperator(r.member?.display_name ?? "Operator");
            idle.reset();
            return { ok: true };
          }}
        />
      )}
    </StationShell>
  );
}
