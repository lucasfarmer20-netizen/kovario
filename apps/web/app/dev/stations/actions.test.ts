import { beforeEach, expect, it, vi } from "vitest";
import { encode } from "rules";
import { demoScan } from "./actions";
import type { ScanRequest } from "@/src/components/station/scan-queue";

const mocks = vi.hoisted(() => ({ getClaims: vi.fn(), rpc: vi.fn(), withAction: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getClaims: mocks.getClaims }, rpc: mocks.rpc }),
}));
vi.mock("@/lib/supabase/env", () => ({
  supabaseEnv: () => ({ url: "http://station.test", anonKey: "" }),
}));
vi.mock("db", async (original) => ({
  ...(await original<typeof import("db")>()),
  withAction: mocks.withAction,
}));
const request: ScanRequest = {
  client_action_id: "station-action-001",
  raw: encode("TOTE", { intakeNumber: "INT-0001", toteNo: 1 }),
  station: "wave",
  operator_session: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getClaims.mockResolvedValue({
    data: { claims: { sub: "user", org_id: "org", app_role: "manager" } },
    error: null,
  });
  mocks.withAction.mockImplementation(
    async (_client: unknown, id: string, fn: (id: string) => Promise<unknown>) => fn(id),
  );
  mocks.rpc.mockResolvedValue({ data: { ok: true, reason: "Tote accepted" }, error: null });
});
it.each([
  ["42501", "scan_not_permitted"],
  ["23505", "scan_conflict"],
  ["23514", "scan_request_rejected"],
  ["22P02", "scan_request_rejected"],
  ["28000", "station_sign_in_required"],
  ["PGRST301", "station_sign_in_required"],
])("acknowledges permanent RPC error %s", async (code, reason) => {
  mocks.rpc.mockResolvedValue({ data: null, error: { code } });
  await expect(demoScan(request, "")).resolves.toEqual({ ok: false, reason });
});
it("acknowledges permission failure from the withAction lookup cause", async () => {
  mocks.withAction.mockRejectedValue(new Error("lookup failed", { cause: { code: "42501" } }));
  await expect(demoScan(request, "")).resolves.toEqual({ ok: false, reason: "scan_not_permitted" });
});
it("rejects an action-id replay belonging to a non-scan action", async () => {
  mocks.withAction.mockResolvedValue({ site_id: "another-action" });
  await expect(demoScan(request, "")).resolves.toEqual({ ok: false, reason: "scan_conflict" });
});
it("acknowledges a missing org session without attempting a scan RPC", async () => {
  mocks.getClaims.mockResolvedValue({ data: null, error: null });
  await expect(demoScan(request, "")).resolves.toEqual({
    ok: false,
    reason: "station_sign_in_required",
  });
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it("acknowledges expired authentication", async () => {
  mocks.getClaims.mockResolvedValue({ data: null, error: { status: 401 } });
  await expect(demoScan(request, "")).resolves.toEqual({
    ok: false,
    reason: "station_sign_in_required",
  });
});
it("keeps authentication service outages retryable", async () => {
  mocks.getClaims.mockResolvedValue({ data: null, error: { status: 503 } });
  await expect(demoScan(request, "")).rejects.toThrow("Scan service unavailable");
});
it.each([{ code: "40001" }, { code: "40P01" }, { status: 429 }, { status: 503 }, { code: "" }])(
  "keeps transient RPC failures retryable: %j",
  async (error) => {
    mocks.rpc.mockResolvedValue({ data: null, error });
    await expect(demoScan(request, "")).rejects.toThrow("Scan service unavailable");
  },
);
it("parses raw on the server and returns the successful RPC reply", async () => {
  await expect(demoScan(request, "")).resolves.toEqual({ ok: true, reason: "Tote accepted" });
  expect(mocks.rpc).toHaveBeenCalledWith(
    "station_scan",
    expect.objectContaining({
      p_parsed: { kind: "TOTE", intakeNumber: "INT-0001", toteNo: 1, legacy: false },
    }),
  );
});
