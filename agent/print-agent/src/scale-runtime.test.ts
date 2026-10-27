import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FilletryClient } from "db";
import { startScales } from "./scale-runtime";
import { openScalePort } from "./scale-port";
vi.mock("./scale-port", () => ({ openScalePort: vi.fn() }));
const open = vi.mocked(openScalePort);
const row = (id: string) => ({ id, port: id, protocol: "toledo_8217" });
function client(result: unknown, rejected = false): FilletryClient {
  return {
    from: () => ({
      select: () => (rejected ? Promise.reject(new Error("unavailable")) : Promise.resolve(result)),
    }),
  } as unknown as FilletryClient;
}
beforeEach(() => {
  vi.useFakeTimers();
  open.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});
it("WP12 scale configuration errors do not reject optional startup", async () => {
  for (const rejected of [false, true]) {
    const error = vi.fn();
    const stop = await startScales(
      client({ data: null, error: { message: "unavailable" } }, rejected),
      error,
    );
    expect(error).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    stop();
  }
});
it("WP12 failing scale port still resolves startup and opens remaining scales", async () => {
  const close = vi.fn(),
    error = vi.fn();
  open.mockRejectedValueOnce(new Error("invalid port")).mockResolvedValue(close);
  const stop = await startScales(client({ data: [row("bad"), row("good")], error: null }), error);
  await vi.advanceTimersByTimeAsync(0);
  expect(open).toHaveBeenCalledTimes(2);
  expect(error).toHaveBeenCalledOnce();
  stop();
  expect(close).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(open).toHaveBeenCalledTimes(2);
});
it("WP12 unplugged scale retries with backoff and recovers without agent restart", async () => {
  const error = vi.fn(),
    close = vi.fn();
  open
    .mockRejectedValueOnce(new Error("unplugged"))
    .mockRejectedValueOnce(new Error("unplugged"))
    .mockResolvedValue(close);
  const stop = await startScales(client({ data: [row("COM3")], error: null }), error);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(999);
  expect(open).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(open).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1999);
  expect(open).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(open).toHaveBeenCalledTimes(3);
  stop();
  expect(close).toHaveBeenCalledOnce();
});
it("WP12 runtime port failure closes old transport and reconnects only once", async () => {
  const close = vi.fn(),
    error = vi.fn();
  open.mockResolvedValue(close);
  const stop = await startScales(client({ data: [row("COM3")], error: null }), error);
  await vi.advanceTimersByTimeAsync(0);
  const disconnect = open.mock.calls[0]![2];
  disconnect();
  disconnect();
  expect(close).toHaveBeenCalledOnce();
  expect(error).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1000);
  expect(open).toHaveBeenCalledTimes(2);
  stop();
  expect(close).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(open).toHaveBeenCalledTimes(2);
});
it("WP12 failed initial scale SELECT recovers in background without restarting print agent", async () => {
  const close = vi.fn(),
    error = vi.fn();
  open.mockResolvedValue(close);
  const select = vi
    .fn()
    .mockResolvedValueOnce({ data: null, error: { message: "network unavailable" } })
    .mockResolvedValueOnce({ data: [row("COM3")], error: null });
  const db = { from: () => ({ select }) } as unknown as FilletryClient;
  const stop = await startScales(db, error);
  expect(error).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(999);
  expect(select).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(select).toHaveBeenCalledTimes(2);
  expect(open).toHaveBeenCalledWith("COM3", expect.any(Function), expect.any(Function));
  stop();
  expect(close).toHaveBeenCalledOnce();
});
it("WP12 configuration retries back off and stop cancels pending retries", async () => {
  const select = vi.fn().mockRejectedValue(new Error("network unavailable"));
  const db = { from: () => ({ select }) } as unknown as FilletryClient;
  const stop = await startScales(db, vi.fn());
  await vi.advanceTimersByTimeAsync(1000);
  expect(select).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1999);
  expect(select).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(select).toHaveBeenCalledTimes(3);
  stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(select).toHaveBeenCalledTimes(3);
  expect(open).not.toHaveBeenCalled();
});
it("WP12 pending configuration never blocks startup and late results are ignored after stop", async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise<unknown>((done) => {
    resolve = done;
  });
  const db = { from: () => ({ select: () => pending }) } as unknown as FilletryClient;
  const error = vi.fn();
  const stop = await startScales(db, error);
  stop();
  resolve({ data: [row("COM3")], error: null });
  await vi.advanceTimersByTimeAsync(0);
  expect(open).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});
