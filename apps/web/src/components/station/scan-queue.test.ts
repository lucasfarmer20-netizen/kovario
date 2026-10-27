import { expect, it, vi } from "vitest";
import { ScanQueue, retryDelay, type PendingScan, type ScanRequest } from "./scan-queue";
const request = (id: string): ScanRequest => ({
  client_action_id: id,
  raw: "KV:TOTE:INT-0001:1",
  station: "wave",
  operator_session: null,
});
function setup(send = vi.fn().mockResolvedValue({ ok: true, reason: "accepted" })) {
  let rows: PendingScan[] = [];
  let now = 0;
  const store = {
    read: async () => structuredClone(rows),
    write: async (value: PendingScan[]) => {
      rows = structuredClone(value);
    },
  };
  const changed = vi.fn();
  const replied = vi.fn();
  return {
    queue: new ScanQueue(store, send, changed, replied, () => now),
    store,
    send,
    changed,
    replied,
    time: (value: number) => {
      now = value;
    },
  };
}
it("persists offline scans and replays FIFO with unchanged idempotency keys", async () => {
  const s = setup();
  await s.queue.enqueue(request("first"));
  await s.queue.enqueue(request("second"));
  await s.queue.drain(false);
  expect(s.send).not.toHaveBeenCalled();
  const reloaded = new ScanQueue(s.store, s.send, s.changed, s.replied);
  await reloaded.drain();
  expect(s.send.mock.calls.map(([r]) => r.client_action_id)).toEqual(["first", "second"]);
  expect(await s.store.read()).toEqual([]);
  expect(s.changed).toHaveBeenLastCalledWith(0);
});
it("backs off a lost response then retries the same action without overtaking", async () => {
  const s = setup();
  s.send.mockRejectedValueOnce(new Error("response lost"));
  await s.queue.enqueue(request("same-id"));
  await s.queue.enqueue(request("next-id"));
  await s.queue.drain();
  await s.queue.drain();
  expect(s.send).toHaveBeenCalledTimes(1);
  s.time(1000);
  await s.queue.drain();
  expect(s.send.mock.calls.map(([r]) => r.client_action_id)).toEqual([
    "same-id",
    "same-id",
    "next-id",
  ]);
});
it("acknowledges business rejections and reconciles feedback without retrying", async () => {
  const s = setup();
  s.send.mockResolvedValueOnce({ ok: false, reason: "unknown_tote" });
  await s.queue.enqueue(request("reject"));
  await Promise.all([s.queue.drain(), s.queue.drain()]);
  expect(s.send).toHaveBeenCalledTimes(1);
  expect(s.replied).toHaveBeenCalledWith({ ok: false, reason: "unknown_tote" });
});
it("reconnect retries immediately and backoff is bounded", async () => {
  const s = setup();
  s.send.mockRejectedValueOnce(new Error("offline"));
  await s.queue.enqueue(request("retry"));
  await s.queue.drain();
  await s.queue.drain(true, true);
  expect(s.send).toHaveBeenCalledTimes(2);
  expect(retryDelay(100)).toBe(30_000);
});
it("never sends a scan if durable storage fails", async () => {
  const s = setup();
  s.store.write = async () => {
    throw new Error("quota");
  };
  await expect(s.queue.enqueue(request("unsaved"))).rejects.toThrow("quota");
  expect(s.send).not.toHaveBeenCalled();
});
