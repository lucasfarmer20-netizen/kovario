// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useScanAction } from "./use-scan-action";

const store = vi.hoisted(() => ({ rows: [] as unknown[], fail: false }));
vi.mock("idb-keyval", () => ({
  createStore: () => ({}),
  get: async () => store.rows,
  set: async (_key: string, rows: unknown[]) => {
    if (store.fail) throw new Error("QuotaExceededError");
    store.rows = rows;
  },
}));

beforeEach(() => {
  store.rows = [];
  store.fail = false;
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: async (_name: string, work: () => unknown) => work() },
  });
});
afterEach(cleanup);

const tap = {
  raw: "",
  vessel_id: "vx",
  station: "blast" as const,
  client_action_id: "tap-1",
  operator_session: null,
};

it("#129 scan resolves true once the request is queued, false when storage refuses it", async () => {
  const send = vi.fn(async () => ({ ok: true, reason: "Exchange basket in blast · INT-0001" }));
  const { result } = renderHook(() => useScanAction("org:staff:blast", send));
  let queued: boolean | undefined;
  await act(async () => {
    queued = await result.current.scan(tap);
  });
  expect(queued).toBe(true);
  expect(send).toHaveBeenCalledWith(tap);
  store.fail = true;
  await act(async () => {
    queued = await result.current.scan({ ...tap, client_action_id: "tap-2" });
  });
  expect(queued).toBe(false);
  expect(result.current.feedback).toMatchObject({
    ok: false,
    reason: "Scan could not be saved. Scan again.",
  });
});
