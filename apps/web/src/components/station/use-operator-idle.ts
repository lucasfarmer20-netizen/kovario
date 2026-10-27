"use client";
import { useCallback, useEffect, useRef } from "react";

export const OPERATOR_IDLE_MS = 15 * 60_000;

/** reset after PIN identification; check synchronously before submitting a scan. */
export function useOperatorIdle(enabled: boolean, onIdle: () => void, idleMs = OPERATOR_IDLE_MS) {
  const lastInteraction = useRef<number | null>(null);
  const expired = useRef(false);
  const callback = useRef(onIdle);
  useEffect(() => {
    callback.current = onIdle;
  });
  const reset = useCallback(() => {
    lastInteraction.current = Date.now();
    expired.current = false;
  }, []);
  const check = useCallback(() => {
    if (!enabled) return false;
    if (lastInteraction.current === null || Date.now() - lastInteraction.current >= idleMs) {
      if (!expired.current) {
        expired.current = true;
        callback.current();
      }
      return true;
    }
    return false;
  }, [enabled, idleMs]);
  useEffect(() => {
    if (!enabled) return;
    const activity = () => {
      if (!check()) lastInteraction.current = Date.now();
    };
    window.addEventListener("pointerdown", activity);
    window.addEventListener("keydown", activity);
    const timer = setInterval(check, 1000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("keydown", activity);
    };
  }, [enabled, check]);
  return { reset, check };
}
