import { expect, it, vi } from "vitest";
import type { FilletryClient } from "db";
import { isReportKind, loadReport, parseReportFilters, reportCsv, type ReportRow } from "./reports";

it("WP21 date filters default to the current month in the org timezone", () => {
  expect(parseReportFilters({}, "America/Anchorage", new Date("2026-11-01T02:00Z"))).toEqual({
    from: "2026-10-01",
    to: "2026-10-31",
    site: "",
  });
});
it("WP21 filters reject invalid dates, reversed ranges, repeated fields and invalid sites", () => {
  for (const params of [
    { from: "2026-02-30" },
    { from: "2026-11-01", to: "2026-10-01" },
    { site: "bad" },
    { from: ["2026-01-01"] },
  ]) {
    expect(() => parseReportFilters(params, "UTC")).toThrow();
  }
  expect(isReportKind("toString")).toBe(false);
  expect(isReportKind("revenue")).toBe(true);
});
it("WP21 CSV exports escaped daily detail and neutralizes tenant spreadsheet formulas", () => {
  const row = {
    org_id: "org",
    site_id: "site",
    day: "2026-10-27",
    species_code: 'salmon,"red"',
    incoming_lb: 12.5,
  } as ReportRow;
  const csv = reportCsv("volume", [row], { site: '=HYPERLINK("bad")\nLodge' });
  expect(csv).toContain('"day","site","species_code","incoming_lb"\r\n');
  expect(csv).toContain('"\'=HYPERLINK(""bad"")\nLodge"');
  expect(csv).toContain('"salmon,""red""","12.5"');
  expect(reportCsv("volume", [], {})).toBe('\uFEFF"day","site","species_code","incoming_lb"\r\n');
});
it("WP21 query applies inclusive dates/site and paginates beyond the API row limit", async () => {
  const query = {
    select: vi.fn(),
    gte: vi.fn(),
    lte: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    order: vi.fn(),
    range: vi.fn(),
  };
  for (const key of ["select", "gte", "lte", "eq", "is", "order"] as const)
    query[key].mockReturnValue(query);
  query.range
    .mockResolvedValueOnce({
      data: Array.from({ length: 500 }, () => ({ day: "2026-10-01" })),
      error: null,
    })
    .mockResolvedValueOnce({ data: [{ day: "2026-10-02" }], error: null });
  const client = { from: vi.fn(() => query) } as unknown as FilletryClient;
  const rows = await loadReport(client, "volume", {
    from: "2026-10-01",
    to: "2026-10-28",
    site: "site",
  });
  expect(rows).toHaveLength(501);
  expect(query.gte).toHaveBeenCalledWith("day", "2026-10-01");
  expect(query.lte).toHaveBeenCalledWith("day", "2026-10-28");
  expect(query.eq).toHaveBeenCalledWith("site_id", "site");
  expect(query.range).toHaveBeenLastCalledWith(500, 999);
  query.range.mockResolvedValue({ data: [], error: null });
  await loadReport(client, "volume", { from: "2026-10-01", to: "2026-10-28", site: "unassigned" });
  expect(query.is).toHaveBeenCalledWith("site_id", null);
  query.range.mockResolvedValue({ data: null, error: { message: "internal" } });
  await expect(
    loadReport(client, "volume", { from: "2026-10-01", to: "2026-10-28", site: "" }),
  ).rejects.toThrow("Could not load reports");
});
