"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { parse } from "rules";
import { sessionForBoxingToken } from "@/components/allocate/allocate-data";
import { useFreezerOperator } from "@/components/freezer/use-freezer-operator";
import {
  managerElevation,
  useStationSession,
  type StationSession,
} from "@/components/intake/use-station-session";
import { ManagerPinOverlay } from "@/src/components/station/pin-overlay";
import { StationShell } from "@/src/components/station/station-shell";
import {
  boxingQueue,
  completeRelease,
  emptiedVessels,
  loadWizard,
  releaseByTag,
  restoreVessel,
  type EmptiedVessel,
  type ReleaseReply,
} from "./boxing-data";
import {
  completePayload,
  emptyTicks,
  lbsValue,
  lineIssues,
  nothingTicked,
  reproject,
  scanTick,
  setLbsLeft,
  toggleBox,
  toggleVessel,
  vesselLabel,
  type Ticks,
  type Wizard,
} from "./boxing-state";

type Feedback = { tone: "ok" | "warn" | "error"; text: string } | null;

function Status({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return (
    <p
      role={feedback.tone === "error" ? "alert" : "status"}
      className={`station-feedback ${feedback.tone === "ok" ? "station-ok" : "station-rejected"}`}
    >
      {feedback.text}
    </p>
  );
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

function BoxingQueue({ client, siteName }: StationSession) {
  const router = useRouter();
  const [rows, setRows] = useState<Awaited<ReturnType<typeof boxingQueue>> | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  useEffect(() => {
    let live = true;
    boxingQueue(client).then(
      (r) => live && setRows(r),
      () => live && setFeedback({ tone: "error", text: "Queue unavailable; reload." }),
    );
    return () => {
      live = false;
    };
  }, [client]);
  return (
    <StationShell
      name="Boxing / will-call"
      site={siteName}
      operator={null}
      pending={0}
      status={<Status feedback={feedback} />}
      onScan={async (raw) => {
        const scanned = parse(raw);
        if (!scanned.ok || scanned.value.kind !== "BOX") {
          setFeedback({ tone: "error", text: "Scan the boxing QR on a settlement receipt" });
          return;
        }
        const id = await sessionForBoxingToken(client, scanned.value.token).catch(() => null);
        if (id) router.push(`/boxing/${id}`);
        else setFeedback({ tone: "error", text: "That boxing QR does not match a settlement" });
      }}
    >
      <section className="station-card" aria-label="Boxing queue">
        <h2>Ready to box</h2>
        {!rows ? (
          <p>Loading…</p>
        ) : rows.length === 0 ? (
          <p>No priced party has boxes left to hand over.</p>
        ) : (
          <ul className="station-queue">
            {rows.map((r) => (
              <li key={r.session_id}>
                <Link href={`/boxing/${r.session_id}`}>
                  {r.number} · {r.party_name ?? "Party"}
                </Link>
                <span className="station-badge">
                  {r.planned_count} of {r.box_count} boxes left
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </StationShell>
  );
}

/** /boxing/[id]: one party's boxes and pick list, ticked and completed. */
export function BoxingStation({ sessionId }: { sessionId: string }) {
  return (
    <NeedSession>
      {(session) => <BoxingParty session={session} sessionId={sessionId} />}
    </NeedSession>
  );
}

type ManagerAction =
  | { kind: "tag"; tag: string; lbsLeft: number | null; reason: string }
  | { kind: "restore"; vessel: EmptiedVessel; reason: string };

function BoxingParty({ session, sessionId }: { session: StationSession; sessionId: string }) {
  const { client, claims, siteName } = session;
  const op = useFreezerOperator({ client, claims });
  const isManager = claims.appRole === "owner" || claims.appRole === "manager";
  const [wizard, setWizard] = useState<Wizard | null>(null);
  const [ticks, setTicks] = useState<Ticks>(emptyTicks);
  const [notices, setNotices] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [reply, setReply] = useState<ReleaseReply | null>(null);
  const [paymentRef, setPaymentRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [emptied, setEmptied] = useState<EmptiedVessel[]>([]);
  const [tagForm, setTagForm] = useState({ tag: "", lbsLeft: "", reason: "" });
  const [restoreReason, setRestoreReason] = useState("");
  const [pending, setPending] = useState<ManagerAction | null>(null);

  const typing = {
    onFocus: () => setEditing(true),
    onBlur: () => setEditing(false),
  };

  /** Fresh projection (I15): keep ticks for still-eligible records, or start clean. */
  async function refresh(reset: boolean) {
    const next = await loadWizard(client, sessionId);
    if (reset) {
      setTicks(emptyTicks());
      setNotices([]);
    } else {
      const r = reproject(wizard, ticks, next);
      setTicks(r.ticks);
      setNotices(r.notices);
    }
    setWizard(next);
    setEmptied(
      await emptiedVessels(
        client,
        next.intakes.map((i) => i.intake_id),
      ),
    );
  }

  useEffect(() => {
    let live = true;
    loadWizard(client, sessionId).then(
      async (next) => {
        if (!live) return;
        setWizard(next);
        const rows = await emptiedVessels(
          client,
          next.intakes.map((i) => i.intake_id),
        );
        if (live) setEmptied(rows);
      },
      () => live && setFeedback({ tone: "error", text: "Party not found." }),
    );
    return () => {
      live = false;
    };
  }, [client, sessionId]);

  async function onScan(raw: string) {
    if (!wizard) return;
    const outcome = scanTick(wizard, ticks, raw);
    if (outcome.kind === "ticked") {
      setTicks(outcome.ticks);
      setFeedback({ tone: "ok", text: outcome.message });
    } else if (outcome.kind === "rejected") {
      setFeedback({ tone: "error", text: outcome.message });
    } else {
      const id = await sessionForBoxingToken(client, outcome.token).catch(() => null);
      if (id === sessionId) {
        // Additive re-scan: re-project, keeping ticks on still-eligible records (P15).
        await refresh(false);
        setFeedback({ tone: "ok", text: `${wizard.number} refreshed` });
      } else
        setFeedback({
          tone: "error",
          text: id
            ? `That receipt belongs to another party; one party per Complete. Finish ${wizard.number} first.`
            : "That boxing QR does not match a settlement",
        });
    }
  }

  async function complete() {
    if (!wizard || busy || !op.allowed()) return;
    const issues = lineIssues(wizard, ticks);
    if (issues.length > 0) {
      setFeedback({ tone: "error", text: issues.map((i) => i.message).join(" · ") });
      return;
    }
    const payload = completePayload(wizard, ticks);
    if (nothingTicked(payload)) {
      setFeedback({ tone: "warn", text: "Nothing ticked: tick boxes or totes before Complete." });
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
      );
      setReply(r);
      if (r.noop) {
        setFeedback({ tone: "warn", text: r.message ?? "Nothing to release." });
        await refresh(false); // stay on the form (I7)
      } else {
        setFeedback({
          tone: "ok",
          text: `Released: ${r.finalized.length} box(es), ${r.moved.length} tote(s).`,
        });
        setPaymentRef("");
        await refresh(true);
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : "Complete failed";
      if (text.includes("operator_pin_required")) op.expire();
      setFeedback({ tone: "error", text });
    } finally {
      setBusy(false);
    }
  }

  async function runManager(action: ManagerAction, token: string | null) {
    if (action.kind === "tag") {
      const r = await releaseByTag(client, action.tag, action.lbsLeft, action.reason, token);
      setFeedback({
        tone: r.noop ? "warn" : "ok",
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
      setFeedback({
        tone: r.restored ? "ok" : "warn",
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
        setFeedback({ tone: "error", text: err instanceof Error ? err.message : "Failed" });
      }
    } else setPending(action);
  }

  if (!wizard)
    return (
      <main className="station">
        <h1>Boxing / will-call</h1>
        <Status feedback={feedback} />
      </main>
    );

  const tickedBoxes = new Set(ticks.boxes);
  const anglers = wizard.anglers.filter((a) =>
    wizard.boxes.some((b) => b.settlement_id === a.settlement_id),
  );
  const toteTicked = Object.values(ticks.vessels).some((l) => l.ticked);
  const issues = new Map(lineIssues(wizard, ticks).map((i) => [i.vesselId, i.message]));

  return (
    <StationShell
      name={`Boxing · ${wizard.number}`}
      site={siteName}
      operator={op.operator}
      pending={busy ? 1 : 0}
      paused={op.pinOpen || editing || pending !== null}
      status={<Status feedback={feedback} />}
      onScan={(raw) => void onScan(raw)}
    >
      <p className="station-hint">
        {wizard.party_name ?? "Party"} · state {wizard.state}
        {wizard.finalized_count > 0 && ` · ${wizard.finalized_count} box(es) already handed over`}
      </p>
      {notices.map((n) => (
        <p key={n} className="station-feedback station-rejected" role="status">
          {n}
        </p>
      ))}
      <div className="station-workspace boxing-workspace">
        <section className="station-card" aria-label="Boxes">
          <h2>Boxes</h2>
          {wizard.boxes.length === 0 && <p>No planned boxes left.</p>}
          {anglers.map((a) => (
            <div key={a.settlement_id}>
              <h3>{a.angler_name}</h3>
              <ul className="station-queue">
                {wizard.boxes
                  .filter((b) => b.settlement_id === a.settlement_id)
                  .map((b) => (
                    <li key={b.box_id}>
                      <label className="intake-toggle">
                        <input
                          type="checkbox"
                          checked={tickedBoxes.has(b.box_id)}
                          onChange={() => setTicks(toggleBox(ticks, b.box_id))}
                        />
                        {b.number} · {b.method === "willcall" ? "will-call" : b.method} ·{" "}
                        {b.size ?? "box"} · {b.weight_lb} lb
                        {b.method === "ship" && ` · ships ${b.ship_date ?? "(no date)"}`}
                      </label>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
          {ticks.boxes.length > 0 && !toteTicked && !wizard.moved_before && (
            <p className="station-hint" role="status">
              No fish has moved for this party yet: tick the totes you are handing over.
            </p>
          )}
        </section>

        <section className="station-card boxing-picklist" aria-label="Pick list">
          <h2>Pick list (walk order)</h2>
          {wizard.vessels.length === 0 && <p>No baskets left in the freezer for this party.</p>}
          <table>
            <thead>
              <tr>
                <th>Tick</th>
                <th>Basket</th>
                <th>Location</th>
                <th>Species</th>
                <th>lb</th>
                <th>Lbs left</th>
              </tr>
            </thead>
            <tbody>
              {wizard.vessels.map((v) => {
                const l = ticks.vessels[v.vessel_id];
                const label = vesselLabel(v);
                return (
                  <tr key={v.vessel_id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Tick ${label}`}
                        checked={l?.ticked ?? false}
                        onChange={() => setTicks(toggleVessel(ticks, v))}
                      />
                    </td>
                    <td>{label}</td>
                    <td>{v.location_code ?? "unlocated"}</td>
                    <td>{v.species_summary ?? ""}</td>
                    <td>{v.weight_lb}</td>
                    <td>
                      <input
                        inputMode="decimal"
                        aria-label={`Lbs left ${label}`}
                        aria-invalid={issues.has(v.vessel_id)}
                        placeholder="0 = all"
                        value={l?.lbsLeft ?? ""}
                        onChange={(e) => setTicks(setLbsLeft(ticks, v, e.target.value))}
                        {...typing}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button type="button" onClick={() => window.print()}>
            Print pick list
          </button>
        </section>

        <section className="station-card" aria-label="Notes">
          <h2>Notes</h2>
          {wizard.intakes.map((i) => (
            <div key={i.intake_id}>
              <h3>
                {i.number} · {i.customer_name}
              </h3>
              <p>
                {i.dirty_fish && <span className="station-badge">DIRTY</span>}{" "}
                {i.ribbing && <span className="station-badge">RIBBING</span>}{" "}
                {i.smoking && <span className="station-badge">SMOKING SPLIT</span>}{" "}
                {i.other_sessions.length > 0 && (
                  <span className="station-badge">also in {i.other_sessions.join(", ")}</span>
                )}
              </p>
              {i.dirty_notes && <p>Dirty: {i.dirty_notes}</p>}
              {i.cut_notes && <p>Cut: {i.cut_notes}</p>}
              {i.processing_notes && <p>Processing: {i.processing_notes}</p>}
              <ul>
                {i.lines.map((ln, n) => (
                  <li key={n}>
                    {ln.species} · {ln.method} · {ln.lb} lb{ln.notes ? ` · ${ln.notes}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      </div>

      <section className="station-card" aria-label="Complete">
        <label>
          Payment ref (receipt / register)
          <input value={paymentRef} onChange={(e) => setPaymentRef(e.target.value)} {...typing} />
        </label>
        <div className="station-actions">
          <button type="button" disabled={busy} onClick={() => void complete()}>
            Complete
          </button>
          <Link href="/boxing">Queue</Link>
        </div>
        {reply && !reply.noop && (
          <ul aria-label="Last Complete">
            {reply.finalized.map((b) => (
              <li key={b.box_id}>
                {b.number} → {b.state.replace("_", " ")}
              </li>
            ))}
            {reply.moved.map((m) => (
              <li key={m.vessel_id}>
                {m.label} → {m.action === "split" ? `split, ${m.weight_left} lb left` : "emptied"}
              </li>
            ))}
            {reply.shipping.map((s) => (
              <li key={s.box_number}>{s.notice}</li>
            ))}
            {reply.closed_intakes.length > 0 && <li>Closed: {reply.closed_intakes.join(", ")}</li>}
          </ul>
        )}
        {reply && reply.stale.length > 0 && (
          <p role="status">
            Already handled elsewhere (dropped): {reply.stale.map((s) => s.label).join(", ")}
          </p>
        )}
      </section>

      <details className="station-card">
        <summary>Manager tools</summary>
        <h3>Release by tag</h3>
        <p className="station-hint">For a tote that was not ticked at Complete. Totes only.</p>
        <div className="intake-fields">
          <label>
            Tag
            <input
              value={tagForm.tag}
              onChange={(e) => setTagForm({ ...tagForm, tag: e.target.value })}
              {...typing}
            />
          </label>
          <label>
            Lbs left
            <input
              inputMode="decimal"
              placeholder="0 = all"
              value={tagForm.lbsLeft}
              onChange={(e) => setTagForm({ ...tagForm, lbsLeft: e.target.value })}
              {...typing}
            />
          </label>
          <label>
            Reason
            <input
              value={tagForm.reason}
              onChange={(e) => setTagForm({ ...tagForm, reason: e.target.value })}
              {...typing}
            />
          </label>
          <button
            type="button"
            disabled={!tagForm.tag.trim() || !tagForm.reason.trim()}
            onClick={() => {
              const lbs = lbsValue(tagForm.lbsLeft);
              if (lbs !== null && (Number.isNaN(lbs) || lbs < 0)) {
                setFeedback({ tone: "error", text: "Lbs left must be a number of 0 or more" });
                return;
              }
              void manager({
                kind: "tag",
                tag: tagForm.tag.trim(),
                lbsLeft: lbs,
                reason: tagForm.reason.trim(),
              });
            }}
          >
            Release by tag
          </button>
        </div>
        <h3>Restore a released basket</h3>
        {emptied.length === 0 ? (
          <p>No released baskets for this party.</p>
        ) : (
          <>
            <label>
              Reason
              <input
                value={restoreReason}
                onChange={(e) => setRestoreReason(e.target.value)}
                {...typing}
              />
            </label>
            <ul className="station-queue">
              {emptied.map((v) => (
                <li key={v.id}>
                  {v.tag_code ? `Tag ${v.tag_code}` : "Basket"} ({v.intake_number}) ·{" "}
                  {v.weight_lb ?? "?"} lb
                  <button
                    type="button"
                    disabled={!restoreReason.trim()}
                    onClick={() =>
                      void manager({ kind: "restore", vessel: v, reason: restoreReason.trim() })
                    }
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </details>

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
