import { useEffect, useState } from "react";

/**
 * `value`, once it has held for `ms` (false again at once when it drops). A reason that waits on
 * scans still sending shows only once the wait lasts, so a quick round trip never flashes it
 * (Locate's exchange taps, Rollstock's Finish queue).
 */
export function useLasting(value: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!value) return;
    const timer = setTimeout(() => setHeld(true), ms);
    return () => {
      clearTimeout(timer);
      setHeld(false);
    };
  }, [value, ms]);
  return value && held;
}
