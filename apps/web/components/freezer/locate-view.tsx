"use client";
import { ChevronRight, MapPin, ScanBarcode } from "lucide-react";
import { BasketRow } from "@/src/components/station/basket-row";
import { DisabledReason } from "@/src/components/station/next-step";

/** The basket step 1 resolved: step 2 places only this one. */
export type LocateBasket = {
  id: string;
  /** Tag code; null for an exchange basket (or a basket whose tag was not returned). */
  code: string | null;
  exchange: boolean;
  order: string | null;
  species: string | null;
};
/** An untagged exchange basket waiting for a location, selected by tap. */
export type LocateExchangeRow = {
  id: string;
  order: string;
  weightLb: number;
  /** "in blast 2h 05m" or "not blasted in". */
  blast: string;
};

export type LocateViewProps = {
  /** First load not back yet: placeholders hold the layout so nothing jumps. */
  loading: boolean;
  basket: LocateBasket | null;
  exchange: readonly LocateExchangeRow[];
  /** An exchange basket tapped, its reply not back yet: a spinner on its row. */
  selecting: string | null;
  /**
   * Why the exchange rows and Scan a different basket wait (scans still sending); "" while they
   * wait with nothing to say yet (a quick round trip); null: live.
   */
  why: string | null;
  on: { select: (id: string) => void; change: () => void };
};

export const LOCATE_STEPS = ["Scan basket", "Scan location"] as const;

/** "Basket 041", "Exchange basket", or "Basket" when the tag is not known. */
export function locateBasketName(basket: Pick<LocateBasket, "code" | "exchange">): string {
  return basket.code ? `Basket ${basket.code}` : basket.exchange ? "Exchange basket" : "Basket";
}

/**
 * The next step line and current step (docs/11-FLOOR-WORDING.md, Locate): scan basket (or tap
 * an exchange basket) → scan location for basket 005.
 */
export function locateNextStep(
  basket: Pick<LocateBasket, "code" | "exchange"> | null,
  exchangeWaiting: number,
): { next: string; step: number } {
  if (basket) {
    const name = locateBasketName(basket);
    return { next: `Scan location for ${name[0]!.toLowerCase()}${name.slice(1)}`, step: 1 };
  }
  return {
    next: exchangeWaiting > 0 ? "Scan basket or tap an exchange basket" : "Scan basket",
    step: 0,
  };
}

/**
 * The Locate floor (docs/06-STATIONS-UX.md Locate): one card for the step (no basket yet: what
 * to scan; a basket scanned: which one, its order and species, and the location it waits for)
 * and, beside it, the exchange baskets waiting for a location, each one tap. The list stays in
 * step 2 with the chosen basket framed, so switching baskets is one tap or one scan.
 * Presentational: the live station and the gallery both render it.
 */
export function LocateView({ loading, basket, exchange, selecting, why, on }: LocateViewProps) {
  const step = loading ? (
    // The shape of the "No basket scanned" card it becomes, so nothing jumps.
    <section className="station-card st-hero-empty" aria-busy="true" aria-label="Opening locate">
      <div className="st-skeleton" style={{ width: 104, height: 104 }} aria-hidden />
      <div className="st-skeleton" style={{ width: "40%", height: 32 }} aria-hidden />
      <div className="st-skeleton" style={{ width: "60%", height: 24 }} aria-hidden />
    </section>
  ) : basket ? (
    <section className="station-card st-item" aria-label="Locate step">
      <div className="st-item-head">
        <div>
          <p className="st-eyebrow">Basket scanned</p>
          <h2>
            {basket.code ? (
              <>
                Basket <span className="st-code">{basket.code}</span>
              </>
            ) : (
              locateBasketName(basket)
            )}
          </h2>
        </div>
        {(basket.order || basket.species) && (
          <ul className="st-facts" aria-label="Basket details">
            {basket.order && (
              <li>
                Order <span className="st-code">{basket.order}</span>
              </li>
            )}
            {basket.species && <li>{basket.species}</li>}
          </ul>
        )}
      </div>
      <p className="st-expect">
        <MapPin size={28} aria-hidden />
        <span>
          <strong>Scan its location</strong>
          <br />
          The shelf or pallet label, like <span className="st-code">IF-A-01-1-F</span>. Wrong
          basket? Scan the right one.
        </span>
      </p>
      <div>
        <button
          type="button"
          className="st-btn-secondary"
          disabled={why !== null}
          onClick={on.change}
        >
          Scan a different basket
        </button>
        <DisabledReason reason={why} />
      </div>
    </section>
  ) : (
    <section className="station-card st-hero-empty" aria-label="Locate step">
      <div className="st-hero-art" aria-hidden>
        <ScanBarcode size={56} strokeWidth={1.6} />
      </div>
      <h2>No basket scanned</h2>
      <p>Scan the basket, then its shelf or pallet location.</p>
    </section>
  );
  const list =
    !loading && exchange.length > 0 ? (
      <section className="station-card" aria-label="Exchange baskets">
        <h2 className="st-card-head">
          Exchange baskets <span className="st-count st-num">{exchange.length}</span>
        </h2>
        <p className="station-hint">Tap the basket you are holding, then scan its location.</p>
        <ul className="st-list">
          {exchange.map((v) => (
            <li key={v.id}>
              <BasketRow
                code={null}
                meta={[
                  <span key="order" className="st-code">
                    {v.order}
                  </span>,
                  `${v.weightLb} lb`,
                  v.blast,
                ]}
                selected={basket?.id === v.id}
                busy={selecting === v.id}
                disabled={why !== null}
                label={`Select exchange basket ${v.order}`}
                onSelect={() => on.select(v.id)}
                end={
                  <>
                    Select
                    <ChevronRight size={22} aria-hidden />
                  </>
                }
              />
            </li>
          ))}
        </ul>
        <DisabledReason reason={why} />
      </section>
    ) : null;
  return (
    <div className="st-floor">
      <div className="st-main">
        {list ? (
          <div className="st-columns">
            {step}
            {list}
          </div>
        ) : (
          step
        )}
      </div>
    </div>
  );
}
