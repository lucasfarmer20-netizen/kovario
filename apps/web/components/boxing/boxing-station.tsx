"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFreezerOperator } from "@/components/freezer/use-freezer-operator";
import {
  managerElevation,
  useStationSession,
  type StationSession,
} from "@/components/intake/use-station-session";
import { useOnline } from "@/src/components/station/connection-chip";
import { ManagerPinOverlay } from "@/src/components/station/pin-overlay";
import { StationShell } from "@/src/components/station/station-shell";
import { useManualOptions, type EntryMethod } from "@/src/components/station/manual-entry";
import { stationMessage } from "@/src/components/station/messages";
import { StationNotice, type NoticeTone } from "@/src/components/station/notice";
import { ScanFeedback } from "@/src/components/station/scan-feedback";
import type { ScanReply } from "@/src/components/station/scan-queue";
import {
  boxingQueue,
  boxingScan,
  completeRelease,
  emptiedVessels,
  loadWizard,
  releaseByTag,
  restoreVessel,
  RpcError,
  type EmptiedVessel,
  type ReleaseReply,
} from "./boxing-data";
import {
  BOXING_STEPS,
  boxingPrompt,
  completePayload,
  completeWhy,
  emptyTicks,
  lbsValue,
  lineIssues,
  nothingLeft,
  nothingTicked,
  reproject,
  scanTick,
  setLbsLeft,
  tickBoxes,
  toggleBox,
  toggleVessel,
  type I8Blocked,
  type Ticks,
  type Wizard,
} from "./boxing-state";
import { BoxingPartyView, BoxingQueueView, type BoxingQueueItem } from "./boxing-view";

/** The scan tile: what the last scan did (accepted / rejected), or null between scans. */
type Tile = (ScanReply & { event: number }) | null;
/** A reply to a tap (Complete, manager tools) under the scan tile. */
type Notice = { tone: NoticeTone; text: string };
const NO_NOTICE: Notice = { tone: "info", text: "" };
const SCAN_UNRECORDED = "Scan not recorded; check the connection and scan again.";

let scanEvent = 0;
/** A scan result for the tile; every result is a new event, so the same text still animates. */
const scanTile = (ok: boolean, text: string): Tile => ({ ok, reason: text, event: ++scanEvent });

/** The scan tile and the reply under it (docs/12: one place for scan feedback). */
function Status({ tile, notice }: { tile: Tile; notice: Notice }) {
  return (
    <>
      <ScanFeedback feedback={tile} idle />
      <StationNotice tone={notice.tone} text={notice.text} />
    </>
  );
}

/** Queue rows from public.allocation_session_list: "Pat Party · 2 of 3 boxes left". */
function queueItems(rows: Awaited<ReturnType<typeof boxingQueue>>): BoxingQueueItem[] {
  return rows.map((r) => ({
    id: r.session_id,
    number: r.number,
    detail: `${r.party_name ?? "Party"} · ${r.planned_count} of ${r.box_count} boxes left`,
  }));
}

function NeedSession({ children }: { children: (session: StationSession) => ReactNode }) {
  const { session, loaded } = useStationSession();
  if (!loaded) return <main className="station">Opening boxing…</main>;
  if (!session)
    return (
      <main className="station">
        <h1>Boxing / will-call</h1>
        <Link href="/login">Sign in</Link> or <Link href="/pair">pair device</Link>
      </main>
    );
  return <>{children(session)}</>;
}

/** /boxing: parties with boxes still to hand over; scanning a receipt's boxing QR opens one. */
export function BoxingQueueStation() {
  return <NeedSession>{(session) => <BoxingQueue {...session} />}</NeedSession>;
}

function BoxingQueue({ client, claims, siteName }: StationSession) {
  const manual = useManualOptions(client, claims.orgId);
  const router = useRouter();
  const [rows, setRows] = useState<BoxingQueueItem[] | null>(null);
  const [tile, setTile] = useState<Tile>(null);
  const [notice, setNotice] = useState<Notice>(NO_NOTICE);
  useEffect(() => {
    let live = true;
    boxingQueue(client).then(
      (r) => live && setRows(queueItems(r)),
      () => {
        if (!live) return;
        setRows([]);
        setNotice({ tone: "error", text: "Queue unavailable; reload." });
      },
    );
    return () => {
      live = false;
    };
  }, [client]);
  const prompt = boxingPrompt(null, emptyTicks());
  return (
    <StationShell
      name="Boxing / will-call"
      site={siteName}
      operator={null}
      pending={0}
      next={prompt.next}
      steps={BOXING_STEPS}
      step={prompt.step}
      manualLabel="Boxing code (on the receipt)"
      status={<Status tile={tile} notice={notice} />}
      manual={{ ...manual, accept: ["BOX"] }}
      onScan={async (raw, _parsed, method) => {
        // The server resolves the receipt and logs the scan (typed or scanned) in scan_log.
        const reply = await boxingScan(client, raw, null, null, method).catch(() => null);
        if (!reply) setTile(scanTile(false, SCAN_UNRECORDED));
        else if (reply.ok && reply.session_id) router.push(`/boxing/${reply.session_id}`);
        else setTile(scanTile(false, stationMessage(reply.reason)));
      }}
    >
      <BoxingQueueView queue={rows} onOpen={(id) => router.push(`/boxing/${id}`)} />
    </StationShell>
  );
}

/** /boxing/[id]: one party's boxes and pick list, ticked and completed. */
export function BoxingStation({ sessionId }: { sessionId: string }) {
  return (
    <NeedSession>
      {/* Keyed: opening another party from the rail starts a clean form (I15). */}
      {(session) => <BoxingParty key={sessionId} session={session} sessionId={sessionId} />}
    </NeedSession>
  );
}

type ManagerAction =
  | { kind: "tag"; tag: string; lbsLeft: number | null; reason: string }
  | { kind: "restore"; vessel: EmptiedVessel; reason: string }
  /** I8 manager override: finalise boxes when no tote is left for this party to tick. */
  | { kind: "i8"; reason: string };

function BoxingParty({ session, sessionId }: { session: StationSession; sessionId: string }) {
  const { client, claims, siteName } = session;
  const manual = useManualOptions(client, claims.orgId);
  const op = useFreezerOperator({ client, claims });
  const isManager = claims.appRole === "owner" || claims.appRole === "manager";
  const [wizard, setWizardState] = useState<Wizard | null>(null);
  const [ticks, setTicks] = useState<Ticks>(emptyTicks);
  // The form as it is NOW. Async work (a scan being validated, a re-projection) applies its
  // result to these, never to the snapshot it started from, so a tick or an Lbs-left edit
  // made meanwhile is kept.
  const wizardRef = useRef<Wizard | null>(null);
  const ticksRef = useRef<Ticks>(emptyTicks());
  /** Bumped when Complete starts and when the form resets: an older scan reply is dropped. */
  const formEpoch = useRef(0);
  const scansInFlight = useRef(0);
  const [validating, setValidating] = useState(0);
  const [notices, setNotices] = useState<string[]>([]);
  const [tile, setTile] = useState<Tile>(null);
  const [notice, setNotice] = useState<Notice>(NO_NOTICE);
  const [failed, setFailed] = useState(false);
  const [queue, setQueue] = useState<BoxingQueueItem[] | null>(null);
  const online = useOnline();
  const router = useRouter();
  const [reply, setReply] = useState<ReleaseReply | null>(null);
  const [paymentRef, setPaymentRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [emptied, setEmptied] = useState<EmptiedVessel[]>([]);
  const [tagForm, setTagForm] = useState({ tag: "", lbsLeft: "", reason: "" });
  const [restoreReason, setRestoreReason] = useState("");
  const [pending, setPending] = useState<ManagerAction | null>(null);
  /**
   * The last Complete's I8 refusal, as the SERVER judged it under lock: `override` when no
   * tote is left (DECISION-23), `tote_left` otherwise. Never inferred from the local
   * (possibly stale) pick list.
   */
  const [i8Blocked, setI8Blocked] = useState<I8Blocked>("none");
  const [i8Reason, setI8Reason] = useState("");

  function setWizard(next: Wizard) {
    wizardRef.current = next;
    setWizardState(next);
  }

  /**
   * Applies `change` to the latest ticks. Any tick change or refresh makes an earlier I8
   * refusal stale: hide its override.
   */
  function updateTicks(change: (current: Ticks) => Ticks) {
    const next = change(ticksRef.current);
    ticksRef.current = next;
    setTicks(next);
    setI8Blocked("none");
  }

  /** Fresh projection (I15): keep ticks for still-eligible records, or start clean. */
  async function refresh(reset: boolean) {
    const next = await loadWizard(client, sessionId);
    if (reset) {
      formEpoch.current++;
      updateTicks(() => emptyTicks());
      setNotices([]);
    } else {
      // Against the form as it is after the load, not as it was when the load started.
      const r = reproject(wizardRef.current, ticksRef.current, next);
      updateTicks(() => r.ticks);
      setNotices(r.notices);
    }
    setWizard(next);
    setFailed(false);
    setEmptied(
      await emptiedVessels(
        client,
        next.intakes.map((i) => i.intake_id),
      ),
    );
  }

  /** The queue rail: the other parties, one tap away. A failed load leaves the last one. */
  function loadQueue() {
    return boxingQueue(client).then(
      (rows) => setQueue(queueItems(rows)),
      () => setQueue((current) => current ?? []),
    );
  }

  useEffect(() => {
    let live = true;
    void boxingQueue(client).then(
      (rows) => live && setQueue(queueItems(rows)),
      () => live && setQueue([]),
    );
    loadWizard(client, sessionId).then(
      async (next) => {
        if (!live) return;
        wizardRef.current = next;
        setWizardState(next);
        const rows = await emptiedVessels(
          client,
          next.intakes.map((i) => i.intake_id),
        );
        if (live) setEmptied(rows);
      },
      () => {
        if (!live) return;
        setFailed(true);
        setNotice({ tone: "error", text: "Party not found." });
      },
    );
    return () => {
      live = false;
    };
  }, [client, sessionId]);

  /**
   * Flow (docs/06 Boxing): once this party has nothing left, the station reads the next
   * receipt's boxing QR as the queue does, so the next party opens without going back.
   */
  async function openFromScan(raw: string, method: EntryMethod) {
    const reply = await boxingScan(client, raw, null, null, method).catch(() => null);
    if (!reply) setTile(scanTile(false, SCAN_UNRECORDED));
    else if (!reply.ok || !reply.session_id) setTile(scanTile(false, stationMessage(reply.reason)));
    else if (reply.session_id !== sessionId) router.push(`/boxing/${reply.session_id}`);
    else {
      // This party's own QR: load it again (a retry after "Party not found", or a refresh).
      const loaded = await refresh(false).then(
        () => true,
        () => false,
      );
      if (loaded && failed) setNotice(NO_NOTICE);
      setTile(
        loaded
          ? scanTile(true, `${wizardRef.current?.number ?? "Party"} refreshed`)
          : scanTile(false, "Party not found."),
      );
    }
  }

  async function onScan(raw: string, method: EntryMethod) {
    // No party on screen (it failed to load) or nothing left in it: the screen asks for a
    // receipt's boxing QR, so read the scan as the queue does (review on #137).
    if (failed || (wizardRef.current && nothingLeft(wizardRef.current)))
      return openFromScan(raw, method);
    if (!wizardRef.current) return;
    // The server validates the code against the masters and this party's pick list (I11),
    // and logs it in scan_log; ticks stay a local projection (I15). The form stays live
    // meanwhile, so the reply is applied to the latest form state below.
    const epoch = formEpoch.current;
    setValidating(++scansInFlight.current);
    let reply: Awaited<ReturnType<typeof boxingScan>> | null;
    try {
      reply = await boxingScan(client, raw, sessionId, op.proof, method).catch(() => null);
    } finally {
      setValidating(--scansInFlight.current);
    }
    if (epoch !== formEpoch.current) {
      // Complete ran (or the form reset) while this was validated: never tick the new form.
      setTile(scanTile(false, "That scan arrived after Complete; scan it again."));
      return;
    }
    if (!reply) {
      setTile(scanTile(false, SCAN_UNRECORDED));
      return;
    }
    if (!reply.ok) {
      if (reply.reason === "operator_pin_required") op.expire();
      setTile(scanTile(false, stationMessage(reply.reason)));
      return;
    }
    if (reply.kind === "BOX") {
      // Additive re-scan: re-project, keeping ticks on still-eligible records (P15).
      await refresh(false);
      setTile(scanTile(true, `${wizardRef.current?.number ?? "Party"} refreshed`));
      return;
    }
    const form = wizardRef.current;
    if (!form) return;
    const outcome = scanTick(form, ticksRef.current, raw);
    if (outcome.kind === "ticked") {
      updateTicks(() => outcome.ticks);
      setTile(scanTile(true, outcome.message));
    } else {
      // The server saw it on the pick list but this projection is stale: re-project.
      await refresh(false).catch(() => undefined);
      setTile(
        scanTile(
          false,
          outcome.kind === "rejected" ? `${outcome.message}; list refreshed` : "Scan again",
        ),
      );
    }
  }

  async function complete(override?: { reason: string; token: string | null }) {
    const form = wizardRef.current;
    if (!form || busy || !op.allowed()) return;
    if (scansInFlight.current > 0) {
      setNotice({ tone: "info", text: "A scan is still being checked; Complete when it lands." });
      return;
    }
    const current = ticksRef.current;
    const issues = lineIssues(form, current);
    if (issues.length > 0) {
      setNotice({ tone: "error", text: issues.map((i) => i.message).join(" · ") });
      return;
    }
    const payload = completePayload(form, current);
    // Scans started from here on belong to the form Complete is about to replace.
    formEpoch.current++;
    if (nothingTicked(payload)) {
      setNotice({
        tone: "info",
        text: "Nothing ticked. Tick each box and basket being handed over, then Complete.",
      });
      return;
    }
    setBusy(true);
    try {
      const r = await completeRelease(
        client,
        crypto.randomUUID(),
        sessionId,
        payload,
        paymentRef,
        op.proof,
        override,
      );
      setReply(r);
      setI8Blocked("none");
      setI8Reason("");
      if (r.noop) {
        setNotice({ tone: "info", text: r.message ?? "Nothing to release." });
        await refresh(false); // stay on the form (I7)
      } else {
        setNotice({
          tone: "ok",
          text: `Released: ${r.finalized.length} box(es), ${r.moved.length} tote(s).`,
        });
        setPaymentRef("");
        await refresh(true);
        void loadQueue();
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : "Complete failed";
      if (text.includes("operator_pin_required")) op.expire();
      // The SQL HINT is the contract (never the English message).
      const hint = err instanceof RpcError ? err.hint : null;
      const blocked =
        hint === "i8_override_available"
          ? "override"
          : hint === "i8_tote_left"
            ? "tote_left"
            : "none";
      // A tote the server still sees may be missing from a stale pick list: re-project
      // (ticks kept for eligible lines, I15) so the operator sees which tote to pick. The
      // refresh clears the panel, so set it afterwards.
      if (blocked === "tote_left") await refresh(false).catch(() => undefined);
      setI8Blocked(blocked);
      setNotice({ tone: "error", text });
    } finally {
      setBusy(false);
    }
  }

  async function runManager(action: ManagerAction, token: string | null) {
    if (action.kind === "i8") {
      await complete({ reason: action.reason, token });
      return;
    }
    if (action.kind === "tag") {
      const r = await releaseByTag(client, action.tag, action.lbsLeft, action.reason, token);
      setNotice({
        tone: r.noop ? "info" : "ok",
        text: [
          r.noop
            ? r.message
            : `${r.label}: ${r.action === "split" ? `split, ${r.weight_left} lb left` : "emptied"}`,
          ...r.warnings,
        ]
          .filter(Boolean)
          .join(" · "),
      });
      setTagForm({ tag: "", lbsLeft: "", reason: "" });
    } else {
      const r = await restoreVessel(client, action.vessel.id, action.reason, token);
      setNotice({
        tone: r.restored ? "ok" : "info",
        text: [r.restored ? `Restored ${r.weight_lb} lb` : r.message, ...r.warnings]
          .filter(Boolean)
          .join(" · "),
      });
      setRestoreReason("");
    }
    await refresh(false);
  }

  async function manager(action: ManagerAction) {
    if (isManager) {
      try {
        await runManager(action, null);
      } catch (err) {
        setNotice({ tone: "error", text: err instanceof Error ? err.message : "Failed" });
      }
    } else setPending(action);
  }

  const releaseTag = () => {
    const lbs = lbsValue(tagForm.lbsLeft);
    if (lbs !== null && (Number.isNaN(lbs) || lbs < 0)) {
      setNotice({ tone: "error", text: "Lbs left must be a number of 0 or more" });
      return;
    }
    void manager({
      kind: "tag",
      tag: tagForm.tag.trim(),
      lbsLeft: lbs,
      reason: tagForm.reason.trim(),
    });
  };

  const done = wizard !== null && nothingLeft(wizard);
  /** The screen asks for a receipt: the party failed to load, or nothing is left in it. */
  const receipt = failed || done;
  const prompt = boxingPrompt(wizard, ticks, i8Blocked);
  const why = wizard ? completeWhy({ wizard, ticks, validating, online }) : null;
  const field = { onFocus: () => setEditing(true), onBlur: () => setEditing(false) };

  return (
    <StationShell
      name="Boxing / will-call"
      site={siteName}
      operator={op.operator}
      pending={validating + (busy ? 1 : 0)}
      paused={op.pinOpen || editing || pending !== null}
      next={prompt.next}
      nextTone={prompt.tone}
      steps={BOXING_STEPS}
      step={prompt.step}
      manualLabel={receipt ? "Boxing code (on the receipt)" : "Basket number"}
      status={<Status tile={tile} notice={notice} />}
      manual={{ ...manual, accept: receipt ? ["BOX"] : ["TAG", "BOX"] }}
      onScan={(raw, _parsed, method) => void onScan(raw, method)}
    >
      <BoxingPartyView
        loading={!wizard && !failed}
        failed={failed}
        wizard={wizard}
        ticks={ticks}
        notices={notices}
        blocked={i8Blocked}
        why={why}
        reply={reply}
        paymentRef={paymentRef}
        i8Reason={i8Reason}
        busy={busy}
        queue={queue}
        field={field}
        tools={{
          emptied,
          tagForm,
          restoreReason,
          on: {
            tagForm: setTagForm,
            restoreReason: setRestoreReason,
            releaseByTag: releaseTag,
            restore: (vessel) =>
              void manager({ kind: "restore", vessel, reason: restoreReason.trim() }),
          },
        }}
        on={{
          toggleBox: (id) => updateTicks((t) => toggleBox(t, id)),
          tickBoxes: (ids) => updateTicks((t) => tickBoxes(t, ids)),
          toggleVessel: (v) => updateTicks((t) => toggleVessel(t, v)),
          lbsLeft: (v, value) => updateTicks((t) => setLbsLeft(t, v, value)),
          paymentRef: setPaymentRef,
          i8Reason: setI8Reason,
          complete: () => void complete(),
          override: () => void manager({ kind: "i8", reason: i8Reason.trim() }),
          print: () => window.print(),
          open: (id) => router.push(`/boxing/${id}`),
        }}
      />
      {pending && (
        <ManagerPinOverlay
          onClose={() => setPending(null)}
          verify={async (pin) => {
            const elevation = await managerElevation(client, pin);
            if ("reason" in elevation) return { ok: false, reason: elevation.reason };
            try {
              await runManager(pending, elevation.token);
            } catch (err) {
              return { ok: false, reason: err instanceof Error ? err.message : "Failed" };
            }
            setPending(null);
            return { ok: true };
          }}
        />
      )}
      {op.overlay}
    </StationShell>
  );
}
