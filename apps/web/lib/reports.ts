import { z } from "zod";
import type { Database, FilletryClient } from "db";

export const REPORTS = {
  volume: {
    view: "report_daily_volume",
    title: "Daily volume",
    columns: ["day", "site_id", "species_code", "incoming_lb"],
  },
  pipeline: {
    view: "report_pipeline",
    title: "Pipeline",
    columns: ["day", "site_id", "state", "intake_count", "incoming_lb"],
  },
  throughput: {
    view: "report_throughput",
    title: "Throughput",
    columns: ["day", "site_id", "stage", "intake_count", "hours"],
  },
  revenue: {
    view: "report_revenue",
    title: "Revenue",
    columns: ["day", "site_id", "kind", "charge_count", "amount"],
  },
  variance: {
    view: "report_reconcile_variance",
    title: "Reconcile variance",
    columns: [
      "day",
      "site_id",
      "species_code",
      "line_count",
      "expected_lb",
      "actual_lb",
      "variance_pct",
    ],
  },
  manual: {
    view: "report_manual_entries",
    title: "Manual entries",
    columns: ["day", "site_id", "station", "entry", "entry_count", "manual_count"],
  },
} as const;
export type ReportKind = keyof typeof REPORTS;
export type ReportRow = Database["public"]["Views"][(typeof REPORTS)[ReportKind]["view"]]["Row"];
export type ReportData = Record<ReportKind, ReportRow[]>;
export type ReportFilters = { from: string; to: string; site: string };
export type ReportParams = Record<string, string | string[] | undefined>;

const filterSchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    site: z.union([z.literal(""), z.literal("unassigned"), z.uuid()]),
  })
  .refine((v) => v.from <= v.to, { message: "Start date must be on or before end date." });

export function parseReportFilters(
  params: ReportParams,
  timezone: string,
  now = new Date(),
): ReportFilters {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  return filterSchema.parse({
    from: params.from ?? `${today.slice(0, 7)}-01`,
    to: params.to ?? today,
    site: params.site ?? "",
  });
}

export function isReportKind(value: string): value is ReportKind {
  return Object.hasOwn(REPORTS, value);
}

/** Stable pagination avoids PostgREST's row cap silently truncating reports/exports. */
export async function loadReport(
  client: FilletryClient,
  kind: ReportKind,
  filters: ReportFilters,
): Promise<ReportRow[]> {
  const report = REPORTS[kind];
  const rows: ReportRow[] = [];
  const size = 500;
  for (let offset = 0; ; offset += size) {
    let query = client
      .from(report.view)
      .select("*")
      .gte("day", filters.from)
      .lte("day", filters.to);
    if (filters.site === "unassigned") query = query.is("site_id", null);
    else if (filters.site) query = query.eq("site_id", filters.site);
    query = query.order("day").order("site_id", { nullsFirst: true });
    for (const column of report.columns.slice(2, 3)) query = query.order(column);
    const { data, error } = await query.range(offset, offset + size - 1);
    if (error) throw new Error("Could not load reports. Please try again.");
    rows.push(...(data ?? []));
    if (!data || data.length < size) return rows;
  }
}

export async function loadReports(
  client: FilletryClient,
  filters: ReportFilters,
): Promise<ReportData> {
  const [volume, pipeline, throughput, revenue, variance, manual] = await Promise.all([
    loadReport(client, "volume", filters),
    loadReport(client, "pipeline", filters),
    loadReport(client, "throughput", filters),
    loadReport(client, "revenue", filters),
    loadReport(client, "variance", filters),
    loadReport(client, "manual", filters),
  ]);
  return { volume, pipeline, throughput, revenue, variance, manual };
}

export function reportValue(row: ReportRow, column: string): string | number | null {
  const value: unknown = Reflect.get(row, column);
  return typeof value === "number" || typeof value === "string" ? value : null;
}

export function reportCsv(
  kind: ReportKind,
  rows: ReportRow[],
  sites: Record<string, string>,
): string {
  const columns = REPORTS[kind].columns;
  const cell = (value: string | number | null) => {
    let text = value === null ? "" : String(value);
    // Text supplied by tenant configuration must never become a spreadsheet formula.
    if (typeof value === "string" && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return (
    "\uFEFF" +
    [
      columns.map((c) => cell(c === "site_id" ? "site" : c)).join(","),
      ...rows.map((row) =>
        columns
          .map((c) =>
            cell(
              c === "site_id"
                ? (sites[String(row.site_id)] ?? "Unassigned / multiple sites")
                : reportValue(row, c),
            ),
          )
          .join(","),
      ),
    ].join("\r\n") +
    "\r\n"
  );
}
