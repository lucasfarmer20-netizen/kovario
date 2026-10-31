"use client";
import { createContext, useContext, useEffect, useState } from "react";

/** Whether the station's scanner is paused (a field, a PIN or a save has it), from the shell. */
export const ScannerPaused = createContext(false);

/**
 * The shell's paused state, shown only once it has lasted 300 ms: a quick save pauses the
 * scanner for a moment and the scan tile should not flicker for it.
 */
export function useShownScannerPaused(): boolean {
  const paused = useContext(ScannerPaused);
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!paused) return;
    const timer = setTimeout(() => setLate(true), 300);
    return () => {
      clearTimeout(timer);
      setLate(false);
    };
  }, [paused]);
  return paused && late;
}
