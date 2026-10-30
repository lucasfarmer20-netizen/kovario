"use client";
import { useState, type ReactNode } from "react";
import { Check, Plus, Snowflake, Trash2 } from "lucide-react";
import { BandChip, VarianceMeter } from "@/src/components/station/band";
import { BasketTile } from "@/src/components/station/basket-tile";
import { ConnectionChip } from "@/src/components/station/connection-chip";
import { ManualEntry } from "@/src/components/station/manual-entry";
import { DisabledReason, NextStep } from "@/src/components/station/next-step";
import { StationNotice } from "@/src/components/station/notice";
import { OrderTile } from "@/src/components/station/order-tile";
import { ManagerPinOverlay, OperatorPinOverlay } from "@/src/components/station/pin-overlay";
import { ScaleReadout } from "@/src/components/station/scale-readout";
import { FeedbackBanner } from "@/src/components/station/scan-feedback";
import { GALLERY_STATES } from "./reconcile-states";

const STEPS = ["Add baskets", "Weigh", "Send to Blast"] as const;
const noop = () => undefined;
const preview = async () => ({ ok: false, reason: "Preview only" });

const COLOURS: Array<[string, string]> = [
  ["--st-ink", "Ink · text, console bar, scale head"],
  ["--st-ink-2", "Ink 2 · secondary text"],
  ["--st-canvas", "Canvas · page"],
  ["--st-surface", "Surface · cards"],
  ["--st-sunken", "Sunken · wells, disabled"],
  ["--st-line", "Line · borders"],
  ["--st-brand", "Brand · the action that moves the order on"],
  ["--st-brand-soft", "Brand soft · selected"],
  ["--st-salmon", "Salmon · mark, manager"],
  ["--st-within-edge", "Within limit"],
  ["--st-near-edge", "Near limit"],
  ["--st-over", "Over limit"],
];
const TYPE: Array<[string, string, string]> = [
  ["--st-fs-next", "Next step line", "Weigh basket 042"],
  ["--st-fs-readout", "Readout", "22.40 lb"],
  ["--st-fs-heading", "Heading", "Order INT-2141"],
  ["--st-fs-title", "Title · feedback", "Basket 042 added to INT-2141"],
  ["--st-fs-body", "Body · buttons", "Accept scale weight"],
  ["--st-fs-label", "Label · helper (floor minimum)", "Tap a basket first"],
];

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="st-gallery-section">
      <h2>{title}</h2>
      {note && <p className="st-gallery-note">{note}</p>}
      {children}
    </section>
  );
}

function Specimen({
  label,
  children,
  wide,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <figure className="st-specimen" data-wide={wide || undefined}>
      <div className="st-specimen-body">{children}</div>
      <figcaption>{label}</figcaption>
    </figure>
  );
}

function ManualEntryDemo({ startOpen }: { startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <ManualEntry
      open={open}
      onOpenChange={setOpen}
      onSubmit={noop}
      label="Basket number"
      placeholder="042"
    />
  );
}

/**
 * /dev/station-gallery: the floor station design system with static props (no DB). Tokens,
 * every shared station component in each of its states, then the Reconcile screen in every
 * state at tablet (1280 × 800) and phone (400 px) widths, each a live page of its own.
 */
export function StationGallery() {
  return (
    <main className="station st-gallery">
      <header className="station-topbar">
        <div className="st-brandline">
          <div>
            <p className="station-eyebrow">Filletry · design system</p>
            <h1>Station gallery</h1>
          </div>
        </div>
        <nav className="station-chips" aria-label="Gallery">
          <a href="#tokens">Tokens</a>
          <a href="#components">Components</a>
          <a href="#reconcile">Reconcile</a>
        </nav>
      </header>

      <Section
        title="Tokens"
        note="One family with tabular figures; label codes in mono, as printed. 18 px floor, ~1.25 scale. 4 px spacing grid; radii 10 / 14 / 20; three elevations; motion 90 / 180 / 260 ms, all off under reduced motion."
      >
        <div id="tokens" className="st-gallery-grid">
          {COLOURS.map(([token, label]) => (
            <Specimen key={token} label={`${label} · ${token}`}>
              <span className="st-swatch" style={{ background: `var(${token})` }} />
            </Specimen>
          ))}
        </div>
        <div className="st-type-scale">
          {TYPE.map(([token, label, sample]) => (
            <div key={token}>
              <span className="st-gallery-note">
                {label} · {token}
              </span>
              <p style={{ fontSize: `var(${token})`, fontWeight: 720, lineHeight: 1.1 }}>
                {sample}
              </p>
            </div>
          ))}
        </div>
      </Section>

      <div id="components" />
      <Section
        title="Next step line and step row"
        note="The largest text on screen. Done steps carry a check; warnings turn the line red."
      >
        <div className="st-gallery-stack">
          <NextStep next="Scan a tote or tap an order" steps={STEPS} step={0} />
          <NextStep next="Weigh basket 042" steps={STEPS} step={1} />
          <NextStep next="Send to Blast" steps={STEPS} step={2} />
          <NextStep
            next="Over the limit (+22%). Check weights before sending."
            steps={STEPS}
            step={2}
            tone="warn"
          />
        </div>
      </Section>

      <Section
        title="Scan tile"
        note="Fixed height beside the next step line: accepts pop, rejects shake, idle says the scanner is listening."
      >
        <div className="st-gallery-grid">
          <Specimen label="Idle">
            <FeedbackBanner tone="idle" text="Scanner ready" />
          </Specimen>
          <Specimen label="Paused (a field is open)">
            <FeedbackBanner tone="paused" text="Scanner paused while a field is open" />
          </Specimen>
          <Specimen label="Accepted">
            <FeedbackBanner tone="ok" text="Basket 042 added to INT-2141" event={1} />
          </Specimen>
          <Specimen label="Rejected">
            <FeedbackBanner
              tone="rejected"
              text="Basket 005 is already on INT-2139. Scan a different basket."
              event={1}
            />
          </Specimen>
        </div>
      </Section>

      <Section title="Replies and connection">
        <div className="st-gallery-grid">
          <Specimen label="Reply: done">
            <StationNotice tone="ok" text="Basket 042 weighed: 22.4 lb" />
          </Specimen>
          <Specimen label="Reply: refused">
            <StationNotice
              tone="error"
              text="Send to Blast refused: INT-2141 is +22%, over the ±15% limit."
            />
          </Specimen>
          <Specimen label="Reply: info">
            <StationNotice tone="info" text="Refresh unavailable; check connection." />
          </Specimen>
          <Specimen label="Connection (console bar)">
            <div className="station-topbar st-gallery-bar">
              <div className="station-chips">
                <ConnectionChip pending={0} online />
                <ConnectionChip pending={3} online />
                <ConnectionChip pending={3} online={false} />
              </div>
            </div>
          </Specimen>
        </div>
      </Section>

      <Section
        title="Buttons"
        note="Brand fill = moves the order on. Secondary = alternatives. Danger = removes. Disabled is a flat steel fill with the reason under it, never a tooltip; it greys only after 200 ms so a quick save never flashes."
      >
        <div className="st-gallery-grid">
          <Specimen label="Hero (primary step)">
            <button className="st-btn-hero st-btn-block">
              <Check size={26} strokeWidth={3} aria-hidden />
              Accept scale weight
            </button>
          </Specimen>
          <Specimen label="Primary">
            <button className="st-btn-block">
              <Snowflake size={22} aria-hidden />
              Send to Blast Freezer
            </button>
          </Specimen>
          <Specimen label="Secondary">
            <button className="st-btn-secondary st-btn-block">
              <Plus size={22} aria-hidden />
              Add exchange basket
            </button>
          </Specimen>
          <Specimen label="Danger">
            <button className="st-btn-danger">
              <Trash2 size={20} aria-hidden />
              Remove selected basket
            </button>
          </Specimen>
          <Specimen label="Disabled + reason">
            <button className="st-btn-hero st-btn-block" disabled>
              <Snowflake size={26} aria-hidden />
              Send to Blast Freezer
            </button>
            <DisabledReason reason="Weigh every basket first" />
          </Specimen>
          <Specimen label="Toggle (pressed)">
            <div className="station-actions">
              <button aria-pressed>
                <Check size={20} strokeWidth={3} aria-hidden />
                Trim-heavy
              </button>
              <button aria-pressed={false}>Spoilage</button>
            </div>
          </Specimen>
        </div>
      </Section>

      <Section
        title="Enter manually"
        note="Closed under the next step line; open, a labelled field with the normal keyboard."
      >
        <div className="st-gallery-grid">
          <Specimen label="Closed">
            <ManualEntryDemo startOpen={false} />
          </Specimen>
          <Specimen label="Open" wide>
            <ManualEntryDemo startOpen />
          </Specimen>
        </div>
      </Section>

      <Section
        title="Variance"
        note="Band = colour + shape + words. The meter runs the full range, −100% to +100%; near is striped, over is hatched; a needle past ±100% turns red."
      >
        <div className="st-gallery-grid">
          <Specimen label="Within">
            <BandChip band="within">within limit</BandChip>
            <VarianceMeter variancePct={3.3} limitPct={15} band="within" />
          </Specimen>
          <Specimen label="Near">
            <BandChip band="near">near limit</BandChip>
            <VarianceMeter variancePct={-11.5} limitPct={15} band="near" />
          </Specimen>
          <Specimen label="Over">
            <BandChip band="over">over limit</BandChip>
            <VarianceMeter variancePct={22} limitPct={15} band="over" />
          </Specimen>
          <Specimen label="Over, at the end of the scale">
            <BandChip band="over">over limit</BandChip>
            <VarianceMeter variancePct={-100} limitPct={15} band="over" />
          </Specimen>
          <Specimen label="Over, past the scale">
            <BandChip band="over">over limit</BandChip>
            <VarianceMeter variancePct={140} limitPct={15} band="over" />
          </Specimen>
          <Specimen label="No estimate">
            <BandChip band="unknown">no estimate</BandChip>
            <VarianceMeter variancePct={null} limitPct={15} band="unknown" />
          </Specimen>
        </div>
      </Section>

      <Section title="Scale" note="The scale head: what Accept will write, and where.">
        <div className="st-gallery-grid">
          <Specimen label="Stable reading">
            <ScaleReadout reading={22.4} state="stable" target="basket 042" />
          </Specimen>
          <Specimen label="Reading already used">
            <ScaleReadout reading={22.4} state="used" target="basket 057" />
          </Specimen>
          <Specimen label="Offline / not assigned">
            <ScaleReadout reading={null} state="none" target="basket 057" />
          </Specimen>
        </div>
      </Section>

      <Section
        title="Baskets"
        note="Selected = where the weight goes. State at the right edge: scale, spinner, check."
      >
        <div className="st-gallery-grid">
          <Specimen label="Not weighed">
            <BasketTile
              code="057"
              exchange={false}
              weightLb={0}
              manual={false}
              selected={false}
              onSelect={noop}
            />
          </Specimen>
          <Specimen label="Selected, to weigh">
            <BasketTile
              code="057"
              exchange={false}
              weightLb={0}
              manual={false}
              selected
              onSelect={noop}
            />
          </Specimen>
          <Specimen label="Saving">
            <BasketTile
              code="057"
              exchange={false}
              weightLb={0}
              manual={false}
              savingLb={17.1}
              selected
              onSelect={noop}
            />
          </Specimen>
          <Specimen label="Weighed">
            <BasketTile
              code="042"
              exchange={false}
              weightLb={22.4}
              manual={false}
              selected={false}
              onSelect={noop}
            />
          </Specimen>
          <Specimen label="Manual weight">
            <BasketTile
              code="042"
              exchange={false}
              weightLb={22.4}
              manual
              selected={false}
              onSelect={noop}
            />
          </Specimen>
          <Specimen label="Exchange basket">
            <BasketTile
              code={null}
              exchange
              weightLb={1.8}
              manual={false}
              selected={false}
              onSelect={noop}
            />
          </Specimen>
        </div>
      </Section>

      <Section
        title="Queue"
        note="Number as on the tote, HELD in words with a lock, summary and time waiting."
      >
        <div className="st-gallery-grid">
          <Specimen label="Waiting">
            <OrderTile
              number="INT-2145"
              detail="Lingcod, Rockfish · 24 lb expected"
              age="34m"
              onOpen={noop}
            />
          </Specimen>
          <Specimen label="Open">
            <OrderTile
              number="INT-2141"
              detail="Reds, Silvers · 40 lb expected"
              age="6m"
              current
              onOpen={noop}
            />
          </Specimen>
          <Specimen label="Held">
            <OrderTile
              number="INT-2142"
              held
              detail="Halibut · 62 lb expected"
              age="18m"
              onOpen={noop}
            />
          </Specimen>
        </div>
      </Section>

      <Section
        title="PIN"
        note="Non-modal sheets: operator (teal) and manager (salmon). Shown in place here."
      >
        <div className="st-gallery-grid st-gallery-inline">
          <Specimen label="Operator PIN">
            <OperatorPinOverlay onClose={noop} verify={preview} />
          </Specimen>
          <Specimen label="Manager PIN">
            <ManagerPinOverlay onClose={noop} verify={preview} />
          </Specimen>
        </div>
      </Section>

      <div id="reconcile" />
      <Section
        title="Reconcile, every state"
        note="Each frame is the live page for that state (open it to try 400 px and 1280 px yourself). Tablet 1280 × 800 and phone 400 × 860, scaled to fit."
      >
        <div className="st-gallery-states">
          {GALLERY_STATES.map((s) => (
            <article key={s.id} className="st-gallery-state">
              <header>
                <h3>
                  <a href={`/dev/station-gallery/${s.id}`}>{s.title}</a>
                </h3>
                <p className="st-gallery-note">{s.note}</p>
              </header>
              <div className="st-gallery-frames">
                <div className="st-frame st-frame-tablet">
                  <iframe
                    title={`${s.title} at 1280 px`}
                    src={`/dev/station-gallery/${s.id}`}
                    loading="lazy"
                  />
                </div>
                <div className="st-frame st-frame-phone">
                  <iframe
                    title={`${s.title} at 400 px`}
                    src={`/dev/station-gallery/${s.id}`}
                    loading="lazy"
                  />
                </div>
              </div>
            </article>
          ))}
        </div>
      </Section>
    </main>
  );
}
