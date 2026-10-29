// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ManagerSession } from "@/lib/auth";
import { adminPageSession } from "@/lib/auth";
import { loadReport, loadReports } from "@/lib/reports";
import ReportsPage from "./page";
import { GET } from "./export/route";

vi.mock("@/lib/auth", () => ({ adminPageSession: vi.fn() }));
vi.mock("@/lib/reports", async (original) => ({
  ...(await original<typeof import("@/lib/reports")>()),
  loadReport: vi.fn(),
  loadReports: vi.fn(),
}));
afterEach(cleanup);
const query = { select: vi.fn(), eq: vi.fn(), single: vi.fn(), order: vi.fn() };
const from = vi.fn(() => query);
beforeEach(() => {
  vi.clearAllMocks();
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.single.mockResolvedValue({ data: { timezone: "UTC" }, error: null });
  query.order.mockResolvedValue({ data: [{ id: "site", name: "Main" }], error: null });
  vi.mocked(adminPageSession).mockResolvedValue({
    supabase: { from },
    claims: { orgId: "org" },
  } as unknown as ManagerSession);
  vi.mocked(loadReport).mockResolvedValue([]);
  vi.mocked(loadReports).mockResolvedValue({
    volume: [],
    pipeline: [],
    throughput: [],
    revenue: [],
    variance: [],
    manual: [],
  });
});
it("WP21 access: non-managers cannot load report pages or export CSV", async () => {
  vi.mocked(adminPageSession).mockResolvedValue(null);
  render(await ReportsPage({ searchParams: Promise.resolve({}) }));
  expect(screen.getByText("Reports are for owners and managers.")).toBeTruthy();
  expect((await GET(new Request("http://localhost/reports/export?report=revenue"))).status).toBe(
    403,
  );
  expect(from).not.toHaveBeenCalled();
  expect(loadReports).not.toHaveBeenCalled();
  expect(loadReport).not.toHaveBeenCalled();
});
it("WP21 page: valid query passes the same date/site filters to all reports", async () => {
  const params = { from: "2026-10-01", to: "2026-10-28", site: "unassigned" };
  render(await ReportsPage({ searchParams: Promise.resolve(params) }));
  expect(loadReports).toHaveBeenCalledWith(expect.anything(), params);
  expect(screen.getByRole("heading", { name: "Reports" })).toBeTruthy();
});
it("WP21 page/export: invalid filters never query reports", async () => {
  render(await ReportsPage({ searchParams: Promise.resolve({ from: "bad" }) }));
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(
    (await GET(new Request("http://localhost/reports/export?report=revenue&from=bad"))).status,
  ).toBe(400);
  expect((await GET(new Request("http://localhost/reports/export?report=unknown"))).status).toBe(
    400,
  );
  expect(loadReport).not.toHaveBeenCalled();
  expect(loadReports).not.toHaveBeenCalled();
});
it("WP21 export: downloads a private CSV with the active date/site selection", async () => {
  const response = await GET(
    new Request(
      "http://localhost/reports/export?report=revenue&from=2026-10-01&to=2026-10-28&site=unassigned",
    ),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-disposition")).toContain(
    "revenue-2026-10-01-2026-10-28.csv",
  );
  expect(await response.text()).toContain('"day","site","kind","charge_count","amount"');
  expect(loadReport).toHaveBeenCalledWith(expect.anything(), "revenue", {
    from: "2026-10-01",
    to: "2026-10-28",
    site: "unassigned",
  });
});
