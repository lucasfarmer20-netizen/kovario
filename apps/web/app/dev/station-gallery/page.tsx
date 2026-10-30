"use client";
import { useEffect, useRef, useState } from "react";
import { StationShell } from "@/src/components/station/station-shell";
import { BasketButton, ScaleReadout, ActionStrip } from "@/src/components/station/workbench";
import { ManualEntry } from "@/src/components/station/manual-entry";
import { OperatorPinOverlay, ManagerPinOverlay } from "@/src/components/station/pin-overlay";
import { ScanFeedback } from "@/src/components/station/scan-feedback";
import { VarianceHoldPanel } from "@/components/reconcile/variance-hold-panel";
import { SuspectPicker, type SuspectRow } from "@/components/reconcile/suspect-picker";
import type { HoldMember } from "@/components/variance/use-variance-holds";

const states = [
  "Weighing",
  "Empty",
  "Loading",
  "Scale offline",
  "Rejected scan",
  "Within limit",
  "Near limit",
  "Over limit",
  "Held",
  "Signed off",
  "Operator PIN",
  "Manager PIN",
  "Offline / 3 pending",
  "Suspects",
] as const;
type State = (typeof states)[number];
const hold: HoldMember[] = [
  {
    hold_id: "hold",
    flagged_intake_id: "order",
    intake_id: "order",
    intake_number: "INT-0002",
    position: 0,
    state: "reconcile",
    actual_lb: 72,
    variance_pct: 20,
    band: "over",
    blocked: true,
    limit_pct: 15,
    signed_off: false,
  },
  {
    hold_id: "hold",
    flagged_intake_id: "order",
    intake_id: "neighbour",
    intake_number: "INT-0003",
    position: 1,
    state: "blast_freezer",
    actual_lb: 40,
    variance_pct: -20,
    band: "over",
    blocked: true,
    limit_pct: 15,
    signed_off: false,
  },
];
const suspects: SuspectRow[] = hold.map((m) => ({
  center_intake_id: "order",
  hold_id: "hold",
  intake_id: m.intake_id!,
  intake_number: m.intake_number!,
  position: m.position!,
  state: m.state!,
  status: m.position === 0 ? "reconciled" : "in_blast",
  waiting: false,
  expected_lb: m.position === 0 ? 60 : 50,
  actual_lb: m.actual_lb!,
  variance_pct: m.variance_pct,
  limit_pct: 15,
  band: "over",
  species: ["salmon"],
}));
export default function StationGallery() {
  const sequence = useRef(0);
  const [state, setState] = useState<State>("Weighing");
  const [selected, setSelected] = useState("005");
  const scalePanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected !== "005" && window.matchMedia("(max-width: 600px)").matches) {
      scalePanel.current?.scrollIntoView({ block: "center", behavior: "instant" });
    }
  }, [selected]);
  const [manual, setManual] = useState(false);
  const [weightOpen, setWeightOpen] = useState(false);
  const [weight, setWeight] = useState("");
  const [note, setNote] = useState(false);
  const [reason, setReason] = useState(false);
  const [message, setMessage] = useState("");
  const [extra, setExtra] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; reason: string; event: number } | null>(
    null,
  );
  const empty = state === "Empty";
  const loading = state === "Loading";
  const held = state === "Held" || state === "Suspects";
  const ready =
    saved ||
    ["Within limit", "Near limit", "Over limit", "Signed off", "Held", "Suspects"].includes(state);
  const band = state === "Near limit" ? "near" : state === "Over limit" || held ? "over" : "within";
  const pin = state === "Operator PIN" || state === "Manager PIN";
  const next = loading
    ? "Scan a tote or tap an order"
    : empty
      ? "Scan basket"
      : held
        ? "Check weights or get a manager sign-off"
        : state === "Over limit"
          ? "Over the limit (+20%). Check weights before sending."
          : ready
            ? "Send to Blast"
            : `Weigh basket ${selected}`;
  const notify = (text: string) => {
    setMessage(text);
    setFeedback({ ok: true, reason: text, event: ++sequence.current });
  };
  const choose = (value: State) => {
    setState(value);
    setSaved(false);
    setExtra([]);
    setMessage("");
    setManual(false);
    setWeightOpen(false);
    setSelected("005");
    setFeedback(
      value === "Rejected scan"
        ? {
            ok: false,
            reason: "Basket 005 is already on INT-0001. Scan a different basket.",
            event: ++sequence.current,
          }
        : null,
    );
  };
  const add = (code: string) => {
    setExtra([...extra, code]);
    setSelected(code);
    setState("Weighing");
    setManual(false);
    setSaved(false);
    notify(`Basket ${code} added to INT-0002`);
  };
  return (
    <StationShell
      className="station-tide"
      name="Reconcile"
      site="Soldotna"
      operator="Alex M."
      pending={state === "Offline / 3 pending" ? 3 : 0}
      paused={manual || weightOpen || note || reason || pin}
      next={next}
      steps={["Add baskets", "Weigh", "Send to Blast"]}
      step={empty || loading ? 0 : ready ? 2 : 1}
      hideManual
      onScan={(_, parsed) => {
        if (parsed.ok && parsed.value.kind === "TAG") add(parsed.value.code);
        else
          setFeedback({
            ok: false,
            reason: "Not a basket. Scan a basket.",
            event: ++sequence.current,
          });
      }}
      status={
        <>
          <ScanFeedback feedback={feedback} />
          <p className="station-message" role="status">
            {state === "Offline / 3 pending"
              ? "Offline · 3 pending. Keep this station open."
              : state === "Signed off"
                ? "Hold signed off"
                : message}
          </p>
        </>
      }
    >
      <div className="station-workspace reconcile-workspace">
        <section className="station-card reconcile-queue">
          <h2>Reconcile queue</h2>
          {["INT-0002", "INT-0003", "INT-0004"].map((id, i) => (
            <button
              key={id}
              aria-pressed={i === 0}
              onClick={() => {
                choose("Empty");
                notify(`Order ${id} opened · gallery example`);
              }}
            >
              {id}
              {i === 1 && <span className="station-manual-mark">HELD</span>}
            </button>
          ))}
          <p className="station-hint">Oldest first</p>
        </section>
        <section className="station-card reconcile-order">
          <h2>{loading ? "Opening order…" : "Order INT-0002"}</h2>
          <div className="reconcile-summary">
            <h3>Expected yield</h3>
            <p>Salmon: 60 lb</p>
            {empty ? (
              <p>Expected 60.00 lb · No baskets yet</p>
            ) : loading ? (
              <p role="status">Loading baskets…</p>
            ) : (
              <p className={`station-band station-band-${band}`}>
                {band === "over"
                  ? "+20% · over limit"
                  : band === "near"
                    ? "+12% · near limit"
                    : "−2% · within limit"}{" "}
                (limit ±15%)
              </p>
            )}
          </div>
          <div className="reconcile-bench">
            <div className="reconcile-baskets">
              <h3>
                Baskets{" "}
                <span className="station-count">{empty || loading ? 0 : 3 + extra.length}</span>
              </h3>
              {empty && (
                <p className="station-hint">Scan basket to add it — or tap Enter manually.</p>
              )}
              <div className="station-basket-list">
                {!empty &&
                  !loading &&
                  ["003", "004", "005", ...extra].map((code) => (
                    <BasketButton
                      key={code}
                      name={`Basket ${code}`}
                      weight={code === "005" && !ready ? 0 : 19.6}
                      manual={code === "004"}
                      selected={selected === code}
                      onClick={() => setSelected(code)}
                    />
                  ))}
              </div>
              <div className="station-actions station-add-basket">
                <ManualEntry
                  open={manual}
                  onOpenChange={setManual}
                  label="Basket number"
                  placeholder="042"
                  options={{ accept: ["TAG"] }}
                  onSubmit={(_, parsed) => {
                    if (parsed.ok && parsed.value.kind === "TAG") add(parsed.value.code);
                  }}
                />
                <button onClick={() => add(`Exchange ${extra.length + 1}`)}>
                  Add exchange basket
                </button>
              </div>
              <div className="reconcile-remove">
                <button disabled={empty || loading} onClick={() => choose("Empty")}>
                  Remove selected basket
                </button>
              </div>
            </div>
            <div className="reconcile-scale" ref={scalePanel}>
              <ScaleReadout
                reading={state === "Scale offline" ? null : 19.6}
                basket={empty || loading ? null : `Basket ${selected}`}
              />
              <button
                disabled={empty || loading || state === "Scale offline"}
                onClick={() => {
                  setSaved(true);
                  notify(`Basket ${selected} weight saved`);
                }}
              >
                Accept scale weight
              </button>
              {(empty || loading || state === "Scale offline") && (
                <p className="station-why">
                  {empty
                    ? "Add a basket first"
                    : loading
                      ? "Wait for the order to open"
                      : "No stable scale reading; enter weight manually"}
                </p>
              )}
              <button disabled={empty || loading} onClick={() => setWeightOpen(true)}>
                Enter weight manually
              </button>
              {weightOpen && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    setWeightOpen(false);
                    setSaved(true);
                    notify(`Basket ${selected} manual weight saved`);
                  }}
                >
                  <label>
                    Manual weight (lb)
                    <input
                      autoFocus
                      type="number"
                      inputMode="decimal"
                      min="0.01"
                      step="0.01"
                      required
                      value={weight}
                      onChange={(e) => setWeight(e.target.value)}
                    />
                  </label>
                  <button>Save manual weight</button>
                  <button type="button" onClick={() => setWeightOpen(false)}>
                    Cancel manual weight
                  </button>
                </form>
              )}
            </div>
          </div>
          <ActionStrip
            summary={`${ready ? 3 : empty || loading ? 0 : 2} of ${empty || loading ? 0 : 3 + extra.length} baskets weighed`}
            disabled={!ready}
            reason={empty ? "Add a basket first" : !ready ? "Weigh every basket first" : null}
            onSend={() => {
              if (state === "Over limit" || held) choose("Held");
              else {
                choose("Empty");
                notify("Order INT-0002 sent to blast");
              }
            }}
          />
        </section>
        {held && (
          <VarianceHoldPanel
            group={hold}
            openIntakeId="order"
            disabled={false}
            editingNote={note}
            onEditNote={setNote}
            onSignOff={() => choose("Manager PIN")}
            onFindSuspects={() => choose("Suspects")}
          />
        )}
        {state === "Suspects" && (
          <SuspectPicker
            rows={suspects}
            bins={[
              {
                id: "basket",
                intake_id: "order",
                weight_lb: 12,
                is_exchange: false,
                asset_tag: { code: "005" },
              },
            ]}
            disabled={false}
            editingReason={reason}
            onEditReason={setReason}
            onMove={() => notify("Basket moved · gallery example")}
            onPullBack={() => notify("Order pulled back · gallery example")}
            onClose={() => choose("Held")}
          />
        )}
      </div>
      <section className="gallery-notes">
        <p className="station-eyebrow">Station component gallery</p>
        <h2>One system. Every shift.</h2>
        <p>
          Interactive examples · no database · choose a state, scan a basket or try the controls.
        </p>
        <div className="gallery-controls">
          {states.map((value) => (
            <button key={value} aria-pressed={state === value} onClick={() => choose(value)}>
              {value}
            </button>
          ))}
        </div>
        <p>
          18 px minimum text · 56 px minimum targets · numbered steps · variance in words and colour
          · reduced-motion support.
        </p>
      </section>
      {state === "Operator PIN" && (
        <OperatorPinOverlay
          onClose={() => choose("Weighing")}
          verify={async () => ({ ok: true })}
        />
      )}
      {state === "Manager PIN" && (
        <ManagerPinOverlay
          onClose={() => choose("Signed off")}
          verify={async () => ({ ok: true })}
        />
      )}
    </StationShell>
  );
}
