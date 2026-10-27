import { parse } from "rules";

/** Ignore only duplicate Enter events, never repeated physical scans of the same tag. */
export function createScanCapture(submit: (raw: string, parsed: ReturnType<typeof parse>) => void) {
  let lastRaw: string | null = null;
  let lastAt = -Infinity;
  return (raw: string, at: number, repeat = false) => {
    if (repeat || (raw === lastRaw && at - lastAt < 80)) return;
    lastRaw = raw;
    lastAt = at;
    submit(raw, parse(raw));
  };
}
