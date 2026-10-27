"use client";
import { useEffect, useRef } from "react";
import type { ParseResult } from "rules";
import { createScanCapture } from "./scan-capture";

export function ScanInput({
  onScan,
  paused = false,
}: {
  onScan: (raw: string, parsed: ParseResult) => void;
  paused?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const callback = useRef(onScan);
  useEffect(() => {
    callback.current = onScan;
  });
  const capture = useRef<ReturnType<typeof createScanCapture> | null>(null);
  useEffect(() => {
    capture.current = createScanCapture((raw, parsed) => callback.current(raw, parsed));
  }, []);
  useEffect(() => {
    if (!paused) input.current?.focus({ preventScroll: true });
  });
  useEffect(() => {
    if (paused) return;
    const focus = () => input.current?.focus({ preventScroll: true });
    window.addEventListener("focus", focus);
    document.addEventListener("pointerup", focus);
    return () => {
      window.removeEventListener("focus", focus);
      document.removeEventListener("pointerup", focus);
    };
  }, [paused]);
  return (
    <input
      ref={input}
      aria-label="Station scanner"
      className="station-scan-input"
      disabled={paused}
      autoComplete="off"
      inputMode="none"
      onBlur={() => {
        if (!paused) requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        const raw = event.currentTarget.value;
        event.currentTarget.value = "";
        capture.current?.(raw, performance.now(), event.repeat);
      }}
    />
  );
}
