// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ReportsDashboard } from "./dashboard";
import type { ReportData } from "@/lib/reports";

afterEach(cleanup);
const data: ReportData = { volume: [], pipeline: [], throughput: [], revenue: [], variance: [] };
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
  expect(screen.getAllByText("No data for this selection.")).toHaveLength(5);
  expect(screen.getAllByRole("link", { name: /Export CSV/ })).toHaveLength(5);
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
  expect(screen.getAllByText("-10")).toHaveLength(2);
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
    within(screen.getByRole("figure", { name: "Reconcile variance chart" })).getByText("-10"),
  ).toBeTruthy();
});
