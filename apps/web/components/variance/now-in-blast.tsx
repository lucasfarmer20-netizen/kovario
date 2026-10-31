"use client";
import { useCallback, useEffect, useState } from "react";
import type { Database, FilletryClient } from "db";
import { formatVariance, VARIANCE_BANDS, type VarianceBand } from "rules";
import { VarianceMeter } from "@/src/components/station/band";

/**
 * "Now in blast" lines (#87): every intake sent to blast while any of its vessels is not yet on
 * a shelf, with its live variance, from public.now_in_blast. Shared by the blast and reconcile
 * stations; the suspect picker (#88) ranks from the same lines and opens on `onSelect`. The view
 * scopes a paired station to its own site (#96); a signed-in manager sees every site.
 */
export type NowInBlastLine = Pick<
  Database["public"]["Views"]["now_in_blast"]["Row"],
  | "intake_id"
  | "intake_number"
  | "variance_pct"
  | "band"
  | "limit_pct"
  | "rollstock_opened_at"
  | "rollstock_scan_id"
>;

const COLUMNS =
  "intake_id,intake_number,variance_pct,band,limit_pct,rollstock_opened_at,rollstock_scan_id";

export const BAND_LABEL: Record<VarianceBand, string> = {
  within: "within limit",
  near: "near limit",
  over: "over limit",
  unknown: "no estimate",
};

export function lineBand(band: string | null): VarianceBand {
  return (VARIANCE_BANDS as readonly string[]).includes(band ?? "")
    ? (band as VarianceBand)
    : "unknown";
}

/** "INT-2120 is in the blast · variance +14%". */
export function nowInBlastText(line: NowInBlastLine): string {
  return `${line.intake_number} is in the blast · variance ${formatVariance(line.variance_pct)}`;
}

/** Rollstock order: when each intake was opened at rollstock, then the scan; never opened last. */
export function nowInBlastOrder(lines: readonly NowInBlastLine[]): NowInBlastLine[] {
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  // Never opened sorts last (Infinity − Infinity is NaN, so ties fall through to the scan id).
  const opened = (l: NowInBlastLine) =>
    l.rollstock_opened_at ? new Date(l.rollstock_opened_at).getTime() : Infinity;
  return [...lines].sort(
    (a, b) =>
      opened(a) - opened(b) ||
      cmp(a.rollstock_scan_id ?? "", b.rollstock_scan_id ?? "") ||
      cmp(a.intake_number, b.intake_number),
  );
}

/** Loads the lines now, on intake / vessel / hold changes in the org (Realtime) and every 30 s. */
export function useNowInBlast(client: FilletryClient, orgId: string, scope: string) {
  const [lines, setLines] = useState<NowInBlastLine[]>([]);
  const [error, setError] = useState(false);
  const refresh = useCallback(async () => {
    const { data, error: e } = await client.from("now_in_blast").select(COLUMNS);
    if (e) {
      setError(true);
      return;
    }
    setError(false);
    setLines(nowInBlastOrder((data ?? []) as NowInBlastLine[]));
  }, [client]);
  useEffect(() => {
    const reload = () => void refresh();
    reload();
    const channel = client.channel(`${scope}:now-in-blast`);
    for (const table of ["intake", "vessel", "variance_hold"])
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: `org_id=eq.${orgId}` },
        reload,
      );
    channel.subscribe();
    const timer = setInterval(reload, 30000);
    return () => {
      clearInterval(timer);
      void client.removeChannel(channel);
    };
  }, [client, orgId, refresh, scope]);
  return { lines, error, refresh };
}

export function NowInBlastList({
  lines,
  error = false,
  onSelect,
  meter = false,
}: {
  lines: readonly NowInBlastLine[];
  error?: boolean;
  onSelect?: (line: NowInBlastLine) => void;
  /** A compact variance meter under each line (the Blast station, #129). */
  meter?: boolean;
}) {
  return (
    <section className="station-card" aria-label="Now in blast">
      <h2>NOW IN BLAST ({lines.length})</h2>
      {error && <p role="alert">Blast lines unavailable; check connection.</p>}
      <ul className="station-blast-lines" data-meter={meter || undefined}>
        {lines.map((line) => {
          const band = lineBand(line.band);
          const text = nowInBlastText(line);
          return (
            <li key={line.intake_id} className={`station-band station-band-${band}`}>
              {onSelect ? (
                <button type="button" onClick={() => onSelect(line)}>
                  {text} · {BAND_LABEL[band]}
                </button>
              ) : (
                <>
                  {text} · {BAND_LABEL[band]}
                </>
              )}
              {meter && line.limit_pct !== null && (
                <VarianceMeter
                  variancePct={line.variance_pct}
                  limitPct={line.limit_pct}
                  band={band}
                  compact
                />
              )}
            </li>
          );
        })}
      </ul>
      {lines.length === 0 && !error && <p>Nothing in the blast</p>}
    </section>
  );
}
