"use client";
import { useCallback, useEffect, useState } from "react";
import { useStationSession, type StationSession } from "@/components/intake/use-station-session";
import { StationShell } from "@/src/components/station/station-shell";
import { ScanFeedback } from "@/src/components/station/scan-feedback";
import { StationNotice } from "@/src/components/station/notice";
import { useScanAction } from "@/src/components/station/use-scan-action";
import { permanentScanFailure } from "@/src/components/station/scan-failure";
import { useManualOptions, withEntryMethod } from "@/src/components/station/manual-entry";
import type { ScanReply, ScanRequest } from "@/src/components/station/scan-queue";
import {
  freezerReply,
  timeIn,
  useFreezerOperator,
  type FreezerReply,
} from "./use-freezer-operator";
import { FREEZER_INTAKE_STATES, useVesselRefresh } from "./live-vessels";
import { LOCATE_STEPS, LocateView, locateNextStep } from "./locate-view";

export type PendingVessel = {
  /** Vessel step 1 resolved. Tags are reusable: step 2 places only this vessel. */
  id: string;
  /** The scanned tag text; "" for an exchange basket selected by tap (keyed by id alone). */
  raw: string;
  tag: string | null;
  intake: string | null;
  species: string | null;
};

function readPending(key: string): PendingVessel | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as PendingVessel | null;
    return value && typeof value.raw === "string" && typeof value.id === "string" ? value : null;
  } catch {
    return null;
  }
}

/** An untagged exchange basket waiting for a shelf: out of blast (or never blasted), unlocated. */
export type ExchangeVessel = {
  id: string;
  weight_lb: number;
  blast_in_at: string | null;
  intake: { number: string } | null;
};

/**
 * The loop's next pending vessel: placed or stale selection → reset; accepted tag (or tapped
 * exchange basket) → hold it with its vessel id; any other rejection → keep.
 */
export function nextPending(
  current: PendingVessel | null,
  reply: FreezerReply,
): PendingVessel | null {
  if (reply.placed || reply.reset) return null;
  if (reply.ok && reply.pending_vessel_id)
    return {
      id: reply.pending_vessel_id,
      raw: reply.pending_vessel_raw ?? "",
      tag: reply.tag_code ?? null,
      intake: reply.intake_number ?? null,
      species: reply.species ?? null,
    };
  return current;
}

/** `value`, once it has held for `ms` (false again at once when it drops). */
function useLasting(value: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!value) return;
    const timer = setTimeout(() => setHeld(true), ms);
    return () => {
      clearTimeout(timer);
      setHeld(false);
    };
  }, [value, ms]);
  return value && held;
}

export function LocateStation() {
  const { session, loaded } = useStationSession();
  if (!loaded) return <main className="station">Opening locate station…</main>;
  if (!session)
    return (
      <main className="station">
        <h1>Locate</h1>
        <a href="/login">Sign in</a> or <a href="/pair">pair device</a>
      </main>
    );
  return <LiveLocate {...session} />;
}

/**
 * Two-step loop: scan a vessel tag (shows intake and species), then scan a location; the
 * placement is written and both steps reset. Archived / unknown locations are rejected by
 * the server. No capacity hints and no fill guidance: the crew chooses F or R. An exchange
 * basket has no tag: step 1 is a tap on the list below, keyed by vessel id (issue #86). The list
 * stays in step 2 with the chosen basket framed, so another tap (or scan) switches baskets (#129).
 */
function LiveLocate({ client, claims, siteName }: StationSession) {
  const scope = `${claims.orgId}:${claims.userId}:locate`;
  const op = useFreezerOperator({ client, claims });
  const { expire } = op;
  const [pendingVessel, setPendingVessel] = useState<PendingVessel | null>(() =>
    typeof window === "undefined" ? null : readPending(scope),
  );
  const remember = useCallback(
    (value: PendingVessel | null) => {
      localStorage.setItem(scope, JSON.stringify(value));
      setPendingVessel(value);
    },
    [scope],
  );
  const [exchange, setExchange] = useState<ExchangeVessel[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  // The exchange basket tapped, its reply not back yet (a spinner on its row).
  const [selecting, setSelecting] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const refresh = useCallback(async () => {
    const { data, error } = await client
      .from("vessel")
      .select("id,weight_lb,blast_in_at,intake!inner(number,state)")
      .eq("lifecycle_state", "occupied")
      .is("asset_tag_id", null)
      .is("location_id", null)
      .in("intake.state", [...FREEZER_INTAKE_STATES])
      .order("blast_in_at", { nullsFirst: false })
      .order("id");
    if (error) throw new Error("Locate refresh unavailable");
    setExchange((data ?? []) as ExchangeVessel[]);
    setNow(new Date());
    setMessage("");
  }, [client]);
  const reload = useCallback(() => {
    void refresh()
      .catch(() => {
        setExchange([]);
        setMessage("Refresh unavailable; check connection.");
      })
      .finally(() => setLoaded(true));
  }, [refresh]);
  useVesselRefresh(client, claims.orgId, scope, reload);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.storageArea === localStorage && (event.key === scope || event.key === null))
        setPendingVessel(readPending(scope));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [scope]);
  const send = useCallback(
    async (request: ScanRequest): Promise<ScanReply> => {
      // ScanQueue holds scan-delivery:<scope> across this call, so the pending vessel read
      // here is the one left by the previously delivered scan, even from another tab.
      const current = readPending(scope);
      const { data, error } = request.vessel_id
        ? await client.rpc("locate_vessel_by_id", {
            p_client_action_id: request.client_action_id,
            p_vessel_id: request.vessel_id,
            p_operator_session: request.operator_session ?? undefined,
          })
        : await withEntryMethod(
            client.rpc("locate_scan", {
              p_client_action_id: request.client_action_id,
              p_raw: request.raw,
              // An exchange basket is pending by id alone: no tag text to send.
              p_pending_vessel_raw: current?.raw || undefined,
              p_pending_vessel_id: current?.id ?? undefined,
              p_operator_session: request.operator_session ?? undefined,
            }),
            request.entry_method,
          );
      if (error) {
        const rejection = permanentScanFailure(error);
        if (rejection) return rejection;
        throw new Error("Scan delivery unavailable");
      }
      const reply = freezerReply(data);
      remember(nextPending(current, reply));
      if (request.vessel_id) setSelecting(null);
      if (reply.reason === "operator_pin_required") expire();
      if (reply.placed) void refresh().catch(() => undefined);
      return reply;
    },
    [client, expire, refresh, remember, scope],
  );
  const { scan, pending, feedback } = useScanAction(scope, send);
  const manual = useManualOptions(client, claims.orgId);
  const select = (vesselId: string) => {
    if (pendingVessel?.id === vesselId) return;
    if (op.allowed()) {
      setSelecting(vesselId);
      void scan({
        raw: "",
        vessel_id: vesselId,
        station: "locate",
        client_action_id: crypto.randomUUID(),
        operator_session: op.proof,
      });
    }
  };
  const cancel = async () => {
    await navigator.locks.request(`scan-delivery:${scope}`, () => remember(null));
  };
  const basket = pendingVessel && {
    id: pendingVessel.id,
    code: pendingVessel.tag,
    exchange: !pendingVessel.tag && pendingVessel.raw === "",
    order: pendingVessel.intake,
    species: pendingVessel.species,
  };
  const prompt = locateNextStep(basket, exchange.length);
  // Taps wait while scans are sending; the reason shows only once they stay pending, so a quick
  // round trip never flashes it (the buttons themselves grey out after 200 ms, docs/12).
  const waiting = useLasting(pending > 0, 600);
  return (
    <StationShell
      name="Locate"
      site={siteName}
      operator={op.operator}
      pending={pending}
      paused={op.pinOpen}
      next={prompt.next}
      steps={LOCATE_STEPS}
      step={prompt.step}
      manualLabel={pendingVessel ? "Location (IF-A-01-1-F)" : "Basket number"}
      status={
        <>
          <ScanFeedback feedback={feedback} idle />
          <StationNotice text={message} tone="error" />
        </>
      }
      manual={{ ...manual, accept: ["TAG", "LOC"] }}
      onScan={(raw, _parsed, method) => {
        if (op.allowed())
          void scan({
            raw,
            station: "locate",
            client_action_id: crypto.randomUUID(),
            operator_session: op.proof,
            entry_method: method,
          });
      }}
    >
      <LocateView
        loading={!loaded}
        basket={basket}
        exchange={exchange.map((v) => ({
          id: v.id,
          order: v.intake?.number ?? "",
          weightLb: v.weight_lb,
          blast: v.blast_in_at ? `in blast ${timeIn(v.blast_in_at, now)}` : "not blasted in",
        }))}
        selecting={selecting}
        why={waiting ? "Waiting for scans to send" : pending > 0 ? "" : null}
        on={{ select, change: () => void cancel() }}
      />
      {op.overlay}
    </StationShell>
  );
}
