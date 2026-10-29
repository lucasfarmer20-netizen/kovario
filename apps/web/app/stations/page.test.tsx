import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Constants } from "db";
import { STATION_ROUTES } from "@/lib/station-routes";
import StationsPage from "./page";

const mocks = vi.hoisted(() => ({ session: vi.fn(), from: vi.fn(), eq: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireStaff: mocks.session }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ supabase: { from: mocks.from }, claims: { orgId: "org" } });
});

function rows(devices: object[], sites: object[]) {
  mocks.from.mockImplementation((table: string) => ({
    select: () =>
      table === "device"
        ? { eq: mocks.eq.mockReturnValue({ order: async () => ({ data: devices }) }) }
        : { order: async () => ({ data: sites }) },
  }));
}

it("fresh org exposes every station and device setup guidance", async () => {
  rows([], []);
  const html = renderToStaticMarkup(await StationsPage());
  expect(html).toContain("All stations");
  expect(html).toContain('href="/admin/devices"');
  for (const kind of Constants.public.Enums.device_station) {
    expect(html).toContain(`href="${STATION_ROUTES[kind].href}"`);
  }
  expect(html.match(/min-h-28/g)).toHaveLength(11);
  expect(html).not.toContain("No site");
  expect(html).toMatch(/href="\/storage"[^>]*>Cold storage<\/a>/);
  expect(html).toMatch(
    /<a(?=[^>]*href="\/storage\/queue")(?=[^>]*min-h-14)[^>]*>Storage queue<\/a>/,
  );
});

it("groups configured devices by site and requests active devices only", async () => {
  rows(
    [
      { id: "one", name: "Counter tablet", station: "intake", site_id: "main" },
      { id: "two", name: "Lodge tablet", station: "boxing", site_id: "lodge" },
      { id: "three", name: "Mobile", station: "wave", site_id: null },
    ],
    [
      { id: "main", name: "Main" },
      { id: "lodge", name: "Lodge" },
    ],
  );
  const html = renderToStaticMarkup(await StationsPage());
  expect(mocks.eq).toHaveBeenCalledWith("is_active", true);
  expect(html).toMatch(/aria-label="Main"[^]*Counter tablet[^]*Intake/);
  expect(html).toMatch(/aria-label="Lodge"[^]*Lodge tablet[^]*Boxing/);
  expect(html).toMatch(/aria-label="No site"[^]*Mobile/);
});

it("unauthenticated visit stops at the staff login guard", async () => {
  mocks.session.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
  await expect(StationsPage()).rejects.toThrow("NEXT_REDIRECT /login");
  expect(mocks.from).not.toHaveBeenCalled();
});
