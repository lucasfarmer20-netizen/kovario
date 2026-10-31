"use client";
import type { ReactNode } from "react";
import { Inbox, ScanBarcode, Snowflake } from "lucide-react";
import { BasketRow } from "@/src/components/station/basket-row";

/** A basket released to the blast, not blasted in yet. */
export type BlastWaitingRow = {
  id: string;
  /** Tag code; null for an exchange basket (blasted in by tap). */
  code: string | null;
  order: string;
  weightLb: number;
  /** Time since the order was sent to blast ("0h 05m"); null when unknown. */
  waiting: string | null;
};
/** A basket in the blast freezer. */
export type BlastInRow = {
  id: string;
  code: string | null;
  order: string;
  weightLb: number;
  /** Time in the blast ("2h 05m"). */
  timeIn: string;
};

export type BlastViewProps = {
  /** First load not back yet: placeholders hold the layout so nothing jumps. */
  loading: boolean;
  /** Oldest release first (`waitingOrder`). */
  waiting: readonly BlastWaitingRow[];
  inBlast: readonly BlastInRow[];
  /** Exchange baskets whose Blast in is on its way: a spinner on the row until the refresh. */
  blasting: readonly string[];
  /** The "now in blast" lines (NowInBlastList), in the rail. */
  blastList: ReactNode;
  on: { blastIn: (id: string) => void };
};

/**
 * The next step line (docs/11-FLOOR-WORDING.md, Blast): scan a basket going in; when only
 * exchange baskets wait, the step is the tap (they have no tag to scan).
 */
export function blastNextStep(waiting: readonly Pick<BlastWaitingRow, "code">[]): string {
  return waiting.length > 0 && waiting.every((v) => v.code === null)
    ? "Tap Blast in for an exchange basket"
    : "Scan a basket going into the blast";
}

const order = (number: string) => (
  <span key="order" className="st-code">
    {number}
  </span>
);

/**
 * The Blast floor (docs/06-STATIONS-UX.md Blast): the work is the baskets released to the
 * blast (scan each; an exchange basket has a Blast in button), then what is in the blast with
 * its time in; the rail has the "now in blast" orders with their variance band and meter.
 * One step, so no step row (docs/11 prompt grammar 3). Presentational: the live station and the
 * gallery both render it.
 */
export function BlastView({ loading, waiting, inBlast, blasting, blastList, on }: BlastViewProps) {
  // Only exchange baskets wait: the tap is the next step, so Blast in is the filled button.
  const tapFirst = waiting.length > 0 && waiting.every((v) => v.code === null);
  const empty = waiting.length === 0 && inBlast.length === 0;
  return (
    <div className="st-floor">
      <div className="st-main">
        {loading ? (
          <div className="st-columns" aria-busy="true" aria-label="Opening blast">
            {[3, 2].map((rows, n) => (
              <section key={n} className="station-card">
                <div className="st-skeleton-list" aria-hidden>
                  <div className="st-skeleton" style={{ height: 32, width: "60%" }} />
                  {Array.from({ length: rows }, (_, r) => (
                    <div key={r} className="st-skeleton" />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : empty ? (
          <section className="station-card st-hero-empty">
            <div className="st-hero-art" aria-hidden>
              <Snowflake size={56} strokeWidth={1.6} />
            </div>
            <h2>Blast freezer empty</h2>
            <p>Baskets appear here when reconcile sends an order to the blast.</p>
          </section>
        ) : (
          <div className="st-columns">
            <section className="station-card" aria-label="Waiting for blast-in">
              <h2 className="st-card-head">
                Released, waiting for blast-in{" "}
                <span className="st-count st-num">{waiting.length}</span>
              </h2>
              {waiting.length > 0 ? (
                <>
                  <p className="station-hint">
                    Scan each basket. Tap Blast in for an exchange basket.
                  </p>
                  <ul className="st-list">
                    {waiting.map((v) => (
                      <li key={v.id}>
                        <BasketRow
                          code={v.code}
                          meta={[
                            order(v.order),
                            `${v.weightLb} lb`,
                            ...(v.waiting ? [`waiting ${v.waiting}`] : []),
                          ]}
                          busy={blasting.includes(v.id)}
                          end={
                            v.code === null ? (
                              <button
                                type="button"
                                className={tapFirst ? undefined : "st-btn-secondary"}
                                aria-label={`Blast in exchange basket ${v.order}`}
                                onClick={() => on.blastIn(v.id)}
                              >
                                <Snowflake size={20} aria-hidden />
                                Blast in
                              </button>
                            ) : (
                              <>
                                <ScanBarcode size={22} aria-hidden />
                                Scan
                              </>
                            )
                          }
                        />
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <div className="st-empty">
                  <Inbox size={32} aria-hidden />
                  <p>
                    <strong>Nothing waiting</strong>
                    <br />
                    Baskets appear here when reconcile sends an order to the blast.
                  </p>
                </div>
              )}
            </section>
            <section className="station-card" aria-label="In blast">
              <h2 className="st-card-head">
                In blast <span className="st-count st-num">{inBlast.length}</span>
              </h2>
              {inBlast.length > 0 ? (
                <ul className="st-list">
                  {inBlast.map((v) => (
                    <li key={v.id}>
                      <BasketRow
                        code={v.code}
                        meta={[order(v.order), `${v.weightLb} lb`]}
                        end={
                          <>
                            <Snowflake size={20} aria-hidden />
                            <span className="st-sr">in blast </span>
                            <span className="st-num">{v.timeIn}</span>
                          </>
                        }
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="st-empty">
                  <Snowflake size={32} aria-hidden />
                  <p>
                    <strong>Nothing in the blast yet</strong>
                    <br />
                    Scan a waiting basket as it goes in.
                  </p>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
      <div className="st-rail">
        {loading ? (
          <section className="station-card" aria-hidden>
            <div className="st-skeleton-list">
              <div className="st-skeleton" style={{ height: 32, width: "70%" }} />
              <div className="st-skeleton" />
              <div className="st-skeleton" />
            </div>
          </section>
        ) : (
          blastList
        )}
      </div>
    </div>
  );
}
