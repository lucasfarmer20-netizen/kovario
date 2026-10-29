import Link from "next/link";
import { yieldVariancePct } from "rules";
import {
  REPORTS,
  reportValue,
  type ReportData,
  type ReportFilters,
  type ReportKind,
  type ReportRow,
} from "@/lib/reports";

const DESCRIPTIONS: Record<ReportKind, string> = {
  volume: "Incoming lb by species and intake date. Drafts and cancellations excluded.",
  pipeline:
    "Current intake counts and incoming lb for the selected intake dates; not a historical snapshot.",
  throughput:
    "Average hours between completed stages, by stage completion date. Missing or reversed timestamps excluded.",
  revenue:
    "Currently settled charges by kind and payment approval date (USD). Excludes tax, tips, comped and voided charges; not net of refunds.",
  variance:
    "Recorded reconcile weights by species and reconcile date. Variance is weighted by expected lb; zero expected lb has no percentage.",
  manual:
    "Codes typed at a station instead of scanned (of all scans that day), and reconcile weights typed instead of read from the scale (of all weighed vessels, by reconcile date).",
};
const METRICS: Record<ReportKind, string> = {
  volume: "incoming_lb",
  pipeline: "intake_count",
  throughput: "hours",
  revenue: "amount",
  variance: "variance_pct",
  manual: "manual_count",
};
const LABELS: Record<string, string> = {
  day: "Date",
  site_id: "Site",
  species_code: "Species",
  incoming_lb: "Incoming lb",
  intake_count: "Intakes",
  state: "State",
  stage: "Stage",
  hours: "Hours",
  kind: "Kind",
  charge_count: "Charges",
  amount: "USD",
  line_count: "Lines",
  expected_lb: "Expected lb",
  actual_lb: "Actual lb",
  variance_pct: "Variance %",
  station: "Station",
  entry: "Entry",
  entry_count: "Total",
  manual_count: "Manual",
};

function chartRows(kind: ReportKind, rows: ReportRow[]) {
  const groups = new Map<
    string,
    { value: number; weight: number; expected: number; actual: number }
  >();
  for (const row of rows) {
    const dimension =
      kind === "volume" || kind === "variance"
        ? "species_code"
        : kind === "pipeline"
          ? "state"
          : kind === "throughput"
            ? "stage"
            : "day";
    const label =
      kind === "manual"
        ? `${reportValue(row, "station")} · ${reportValue(row, "entry") === "weight" ? "weights" : "codes"}`
        : String(reportValue(row, dimension));
    const g = groups.get(label) ?? { value: 0, weight: 0, expected: 0, actual: 0 };
    const weight = kind === "throughput" ? Number(reportValue(row, "intake_count")) : 1;
    g.value += Number(reportValue(row, METRICS[kind])) * weight;
    g.weight += weight;
    g.expected += Number(reportValue(row, "expected_lb"));
    g.actual += Number(reportValue(row, "actual_lb"));
    groups.set(label, g);
  }
  return [...groups].map(([label, g]) => ({
    label,
    value:
      kind === "throughput"
        ? g.value / g.weight
        : kind === "variance"
          ? yieldVariancePct(g.actual, g.expected)
          : g.value,
  }));
}

export function ReportsDashboard({
  filters,
  data,
  sites,
  timezone,
}: {
  filters: ReportFilters;
  data: ReportData;
  sites: { id: string; name: string }[];
  timezone: string;
}) {
  const siteNames = Object.fromEntries(sites.map((s) => [s.id, s.name]));
  const query = new URLSearchParams(filters);
  return (
    <main className="mx-auto max-w-7xl space-y-8 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Filletry · {timezone}</p>
          <h1 className="text-3xl font-semibold">Reports</h1>
        </div>
        <Link href="/admin" className="underline">
          Admin
        </Link>
      </header>
      <form
        action="/reports"
        method="get"
        className="flex flex-wrap items-end gap-4 rounded-xl border bg-muted/30 p-4"
      >
        <label className="grid gap-2">
          From
          <input
            className="min-h-14 rounded border bg-background px-3"
            type="date"
            name="from"
            defaultValue={filters.from}
            required
          />
        </label>
        <label className="grid gap-2">
          To
          <input
            className="min-h-14 rounded border bg-background px-3"
            type="date"
            name="to"
            defaultValue={filters.to}
            required
          />
        </label>
        <label className="grid gap-2">
          Site
          <select
            name="site"
            defaultValue={filters.site}
            className="min-h-14 rounded border bg-background px-3"
          >
            <option value="">All sites</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value="unassigned">Unassigned / multiple sites</option>
          </select>
        </label>
        <button className="min-h-14 rounded bg-primary px-6 text-primary-foreground" type="submit">
          Apply filters
        </button>
      </form>
      <p className="text-sm text-muted-foreground">
        Dates are inclusive in {timezone}. Charts summarize the selection; tables and CSV retain
        daily site detail. Revenue without a unique source site is unassigned.
      </p>
      <div className="grid items-start gap-6 lg:grid-cols-2">
        {(Object.keys(REPORTS) as ReportKind[]).map((kind) => {
          const report = REPORTS[kind];
          const rows = data[kind];
          const bars = chartRows(kind, rows);
          const max = Math.max(1, ...bars.map((b) => Math.abs(b.value ?? 0)));
          return (
            <section
              key={kind}
              aria-labelledby={`${kind}-title`}
              className="min-w-0 space-y-4 rounded-xl border p-5"
            >
              <div className="flex items-center justify-between gap-3">
                <h2 id={`${kind}-title`} className="text-xl font-semibold">
                  {report.title}
                </h2>
                <a
                  href={`/reports/export?${query}&report=${kind}`}
                  className="inline-flex min-h-14 items-center underline"
                  download
                >
                  Export CSV<span className="sr-only"> — {report.title}</span>
                </a>
              </div>
              <p className="text-sm text-muted-foreground">{DESCRIPTIONS[kind]}</p>
              {!rows.length ? (
                <div>
                  <p>No data for this selection.</p>
                  {kind === "variance" ? (
                    <p className="mt-2 text-sm text-muted-foreground">
                      Variance requires recorded reconcile measurements attributed to intake lines.
                    </p>
                  ) : null}
                </div>
              ) : (
                <>
                  <figure aria-label={`${report.title} chart`} className="space-y-3">
                    <figcaption className="text-sm font-medium">{LABELS[METRICS[kind]]}</figcaption>
                    {bars.map((bar) => (
                      <div key={bar.label} className="space-y-1">
                        <div className="flex justify-between gap-3 text-sm">
                          <span>{bar.label}</span>
                          <span>
                            {bar.value === null
                              ? "—"
                              : bar.value.toLocaleString("en-US", { maximumFractionDigits: 2 })}
                          </span>
                        </div>
                        <div className="h-3 rounded bg-muted">
                          <div
                            className={`h-3 rounded ${bar.value !== null && bar.value < 0 ? "bg-orange-600" : "bg-teal-700"}`}
                            style={{ width: `${(Math.abs(bar.value ?? 0) / max) * 100}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </figure>
                  <div className="max-h-96 overflow-auto">
                    <table className="w-full text-left text-sm">
                      <caption className="sr-only">{report.title} daily detail</caption>
                      <thead>
                        <tr>
                          {report.columns.map((c) => (
                            <th scope="col" className="whitespace-nowrap border-b p-2" key={c}>
                              {LABELS[c]}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row, index) => (
                          <tr key={index}>
                            {report.columns.map((c) => (
                              <td className="whitespace-nowrap border-b p-2" key={c}>
                                {c === "site_id"
                                  ? (siteNames[String(row.site_id)] ??
                                    "Unassigned / multiple sites")
                                  : typeof reportValue(row, c) === "number"
                                    ? Number(reportValue(row, c)).toLocaleString("en-US", {
                                        maximumFractionDigits: 2,
                                      })
                                    : (reportValue(row, c) ?? "—")}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>
          );
        })}
      </div>
    </main>
  );
}
