// @vitest-environment jsdom
import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OPERATOR_IDLE_MS, useOperatorIdle } from "./use-operator-idle";
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("expires an identified operator after fifteen idle minutes", () => {
  const onIdle = vi.fn();
  const { result } = renderHook(() => useOperatorIdle(true, onIdle));
  act(() => result.current.reset());
  act(() => vi.advanceTimersByTime(OPERATOR_IDLE_MS - 1000));
  expect(onIdle).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1000));
  expect(onIdle).toHaveBeenCalledTimes(1);
});
it("extends idle time for keyboard and pointer activity", () => {
  const onIdle = vi.fn();
  const { result } = renderHook(() => useOperatorIdle(true, onIdle));
  act(() => result.current.reset());
  act(() => vi.advanceTimersByTime(OPERATOR_IDLE_MS / 2));
  fireEvent.keyDown(window, { key: "1" });
  act(() => vi.advanceTimersByTime(OPERATOR_IDLE_MS / 2));
  fireEvent.pointerDown(window);
  expect(onIdle).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(OPERATOR_IDLE_MS));
  expect(onIdle).toHaveBeenCalledTimes(1);
});
it("blocks an expired scan synchronously before the timer runs and only notifies once", () => {
  const onIdle = vi.fn();
  const { result } = renderHook(() => useOperatorIdle(true, onIdle));
  act(() => result.current.reset());
  vi.setSystemTime(OPERATOR_IDLE_MS + 1);
  act(() => {
    expect(result.current.check()).toBe(true);
    expect(result.current.check()).toBe(true);
  });
  fireEvent.keyDown(window, { key: "Enter" });
  expect(onIdle).toHaveBeenCalledTimes(1);
  act(() => result.current.reset());
  expect(result.current.check()).toBe(false);
});
it("does not gate a staff station when idle identification is disabled", () => {
  const onIdle = vi.fn();
  const { result } = renderHook(() => useOperatorIdle(false, onIdle));
  act(() => vi.advanceTimersByTime(OPERATOR_IDLE_MS * 2));
  expect(result.current.check()).toBe(false);
  expect(onIdle).not.toHaveBeenCalled();
});
