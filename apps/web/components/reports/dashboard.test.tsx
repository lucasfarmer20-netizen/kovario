// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { formatVariance } from "rules";
import { ReportsDashboard } from "./dashboard";
import { nowInBlastText } from "@/components/variance/now-in-blast";
import type { ReportData } from "@/lib/reports";

afterEach(cleanup);
const data: ReportData = {
  volume: [],
  pipeline: [],
  throughput: [],
  revenue: [],
  variance: [],
  manual: [],
  holds: [],
};
const filters = { from: "2026-10-01", to: "2026-10-28", site: "site" };
it("WP21 dashboard renders date/site controls, five empty states and filtered CSV links", () => {
  render(
    <ReportsDashboard
      data={data}
      filters={filters}
      sites={[{ id: "site", name: "Main" }]}
      timezone="America/Anchorage"
    />,
  );
  expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe(filters.from);
  expect((screen.getByLabelText("To") as HTMLInputElement).value).toBe(filters.to);
  expect((screen.getByLabelText("Site") as HTMLSelectElement).value).toBe("site");
  expect(screen.getAllByText("No data for this selection.")).toHaveLength(7);
  expect(screen.getAllByRole("link", { name: /Export CSV/ })).toHaveLength(7);
  expect(
    screen.getByRole("link", { name: /Export CSV — Daily volume/ }).getAttribute("href"),
  ).toContain("from=2026-10-01&to=2026-10-28&site=site&report=volume");
  expect(
    screen.getByRole("button", { name: "Apply filters" }).closest("form")?.getAttribute("method"),
  ).toBe("get");
});
it("WP21 dashboard shows charts and daily tables with units and signed variance", () => {
  render(
    <ReportsDashboard
      filters={filters}
      sites={[]}
      timezone="UTC"
      data={{
        ...data,
        variance: [
          {
            org_id: "org",
            site_id: null,
            day: "2026-10-27",
            species_code: "salmon",
            line_count: 2,
            expected_lb: 200,
            actual_lb: 180,
            variance_pct: -10,
          },
        ],
      }}
    />,
  );
  expect(screen.getByRole("figure", { name: "Reconcile variance chart" })).toBeTruthy();
  expect(screen.getByRole("table", { name: "Reconcile variance daily detail" })).toBeTruthy();
  expect(screen.getAllByText("−10%")).toHaveLength(2);
  expect(screen.getByText("Expected lb")).toBeTruthy();
});

it("WP21 charts weight throughput by samples and variance by expected lb", () => {
  render(
    <ReportsDashboard
      filters={filters}
      sites={[]}
      timezone="UTC"
      data={{
        ...data,
        throughput: [
          {
            org_id: "org",
            site_id: null,
            day: "2026-10-26",
            stage: "Reconcile → blast",
            intake_count: 1,
            hours: 1,
          },
          {
            org_id: "org",
            site_id: null,
            day: "2026-10-27",
            stage: "Reconcile → blast",
            intake_count: 3,
            hours: 4,
          },
        ],
        variance: [
          {
            org_id: "org",
            site_id: null,
            day: "2026-10-26",
            species_code: "salmon",
            line_count: 1,
            expected_lb: 50,
            actual_lb: 60,
            variance_pct: 20,
          },
          {
            org_id: "org",
            site_id: null,
            day: "2026-10-27",
            species_code: "salmon",
            line_count: 1,
            expected_lb: 150,
            actual_lb: 120,
            variance_pct: -20,
          },
        ],
      }}
    />,
  );
  expect(
    within(screen.getByRole("figure", { name: "Throughput chart" })).getByText("3.25"),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("figure", { name: "Reconcile variance chart" })).getByText("−10%"),
  ).toBeTruthy();
});

it("#84 manual entries: typed codes by station and manual weights, beside the totals", () => {
  const row = (station: string, entry: string, entry_count: number, manual_count: number) => ({
    org_id: "org",
    site_id: null,
    day: "2026-10-27",
    station,
    entry,
    entry_count,
    manual_count,
  });
  render(
    <ReportsDashboard
      filters={filters}
      sites={[]}
      timezone="UTC"
      data={{
        ...data,
        manual: [
          row("wave", "code", 40, 3),
          row("reconcile", "code", 12, 1),
          row("reconcile", "weight", 9, 2),
        ],
      }}
    />,
  );
  const chart = screen.getByRole("figure", { name: "Manual entries chart" });
  expect(within(chart).getByText("wave · codes")).toBeTruthy();
  expect(within(chart).getByText("reconcile · weights")).toBeTruthy();
  const table = screen.getByRole("table", { name: "Manual entries daily detail" });
  expect(within(table).getByText("Manual")).toBeTruthy();
  expect(within(table).getByText("weight")).toBeTruthy();
  expect(
    screen.getByRole("link", { name: /Export CSV — Manual entries/ }).getAttribute("href"),
  ).toContain("report=manual");
});

it("#87 variance holds: who signed off, when, why and the variance, counted by outcome", () => {
  const row = (intake: string, outcome: string, by: string | null, reason: string | null) => ({
    org_id: "org",
    site_id: null,
    day: "2026-10-27",
    intake_number: intake,
    variance_pct: 40,
    limit_pct: 15,
    outcome,
    signed_off_by: by,
    cleared_at: by ? "2026-10-27T10:00:00+00:00" : null,
    reason,
    note: reason === "other" ? "Bled fish" : null,
    cleared_variance_pct: 40,
  });
  render(
    <ReportsDashboard
      filters={filters}
      sites={[]}
      timezone="UTC"
      data={{
        ...data,
        holds: [
          row("INT-0003", "signoff", "Variance manager", "trim_heavy"),
          row("INT-0004", "signoff", "Variance manager", "other"),
          row("INT-0011", "auto", null, null),
        ],
      }}
    />,
  );
  const chart = screen.getByRole("figure", { name: "Variance holds chart" });
  expect(within(chart).getByText("signoff")).toBeTruthy();
  expect(within(chart).getByText("2")).toBeTruthy();
  const table = screen.getByRole("table", { name: "Variance holds daily detail" });
  for (const header of [
    "Signed off by",
    "Cleared at",
    "Reason",
    "Variance",
    "Variance at clearing",
  ])
    expect(within(table).getByText(header)).toBeTruthy();
  expect(within(table).getAllByText("Variance manager")).toHaveLength(2);
  expect(within(table).getByText("trim_heavy")).toBeTruthy();
});

it("#94 report variance is the reconcile / blast text: formatVariance, not the raw number", () => {
  const hold = {
    org_id: "org",
    site_id: null,
    day: "2026-10-27",
    intake_number: "INT-0003",
    variance_pct: 40,
    limit_pct: 15,
    outcome: "active",
    signed_off_by: null,
    cleared_at: null,
    reason: null,
    note: null,
    cleared_variance_pct: null,
  };
  render(
    <ReportsDashboard
      filters={filters}
      sites={[]}
      timezone="UTC"
      data={{ ...data, holds: [hold, { ...hold, intake_number: "INT-0004", variance_pct: -3.54 }] }}
    />,
  );
  const table = screen.getByRole("table", { name: "Variance holds daily detail" });
  const blast = nowInBlastText({
    intake_id: "i",
    intake_number: "INT-0003",
    variance_pct: 40,
    band: "over",
    limit_pct: 15,
    rollstock_opened_at: null,
    rollstock_scan_id: null,
  });
  expect(blast).toBe("INT-0003 is in the blast · variance +40%");
  expect(within(table).getByText(formatVariance(40))).toBeTruthy();
  expect(within(table).getByText("−3.5%")).toBeTruthy();
  expect(within(table).queryByText("40")).toBeNull();
  // Not cleared yet: no variance at clearing.
  expect(within(table).getAllByText("—").length).toBeGreaterThanOrEqual(2);
});
