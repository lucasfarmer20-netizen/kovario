import { describe, expect, it, vi } from "vitest";
import { encode } from "rules";
import { createScanCapture } from "./scan-capture";
describe("ScanInput capture", () => {
  it("parses pasted wedge payloads through the canonical QR parser", () => {
    const submit = vi.fn();
    const capture = createScanCapture(submit);
    const raw = `${encode("TOTE", { intakeNumber: "INT-0001", toteNo: 1 })}\r\n`;
    capture(raw, 0);
    expect(submit).toHaveBeenCalledWith(raw, {
      ok: true,
      value: { kind: "TOTE", intakeNumber: "INT-0001", toteNo: 1, legacy: false },
    });
  });
  it("debounces duplicate terminators but accepts subsequent scans and rejects", () => {
    const submit = vi.fn();
    const capture = createScanCapture(submit);
    capture("42", 0);
    capture("42", 20);
    capture("42", 100, true);
    capture("42", 200);
    capture("unknown", 220);
    expect(submit).toHaveBeenCalledTimes(3);
    expect(submit.mock.calls[2]?.[1]).toEqual({ ok: false, reason: "unknown_format" });
  });
});
