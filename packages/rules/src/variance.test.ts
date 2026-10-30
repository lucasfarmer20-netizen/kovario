import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { variancePercent } from "./reconcile";
import {
  exceedsVarianceHold,
  formatVariance,
  holdGroup,
  rollstockSequence,
  SIGNOFF_NOTE_TOO_LONG,
  SIGNOFF_OTHER_NEEDS_NOTE,
  SIGNOFF_UNKNOWN_REASON,
  VARIANCE_HOLD_PCT_DEFAULT,
  VARIANCE_SETTING_PROBLEM,
  VARIANCE_SIGNOFF_REASONS,
  varianceBand,
  varianceHoldLimit,
  varianceHoldSettingProblem,
  varianceSignoffProblem,
  type RollstockScan,
} from "./variance";
import { renderVarianceSql, VARIANCE_SQL_PATH } from "./variance-sql";

describe("variance band (#87)", () => {
  it("V-band over is strictly past the limit; exactly at the limit is near", () => {
    expect(varianceBand(115, 100, 15)).toBe("near");
    expect(varianceBand(115.01, 100, 15)).toBe("over");
    expect(varianceBand(85, 100, 15)).toBe("near");
    expect(varianceBand(84.99, 100, 15)).toBe("over");
    expect(exceedsVarianceHold(115.01, 100, 15)).toBe(true);
    expect(exceedsVarianceHold(115, 100, 15)).toBe(false);
  });
  it("V-band near starts at 2/3 of the limit, either sign", () => {
    expect(varianceBand(110, 100, 15)).toBe("near");
    expect(varianceBand(109.99, 100, 15)).toBe("within");
    expect(varianceBand(90, 100, 15)).toBe("near");
    expect(varianceBand(100, 100, 15)).toBe("within");
  });
  it("V-band is exact at 2 decimals (no float drift at the boundary)", () => {
    // 0.1 + 0.2 style inputs: 11.5 vs 10 at 15% is exactly the limit.
    expect(varianceBand(11.5, 10, 15)).toBe("near");
    expect(varianceBand(0.1 + 0.2, 0.3, 1)).toBe("within");
  });
  it("V-band is unknown with no expectation, so it never holds", () => {
    expect(varianceBand(50, 0, 15)).toBe("unknown");
    expect(exceedsVarianceHold(50, 0, 15)).toBe(false);
  });
  it("V-band rejects bad limits and weights", () => {
    for (const limit of [0, 101, 15.5, Number.NaN])
      expect(() => varianceBand(1, 1, limit)).toThrow();
    for (const lb of [-1, Number.NaN, Infinity]) expect(() => varianceBand(lb, 1, 15)).toThrow();
  });
  it("variancePercent rounds halves away from zero like SQL round()", () => {
    expect(variancePercent(33, 32)).toBe(3.13);
    expect(variancePercent(31, 32)).toBe(-3.13);
    expect(variancePercent(100, 100)).toBe(0);
    expect(Object.is(variancePercent(100, 100), -0)).toBe(false);
  });
  it("formats the 'now in blast' variance", () => {
    expect(formatVariance(14)).toBe("+14%");
    expect(formatVariance(-3.54)).toBe("−3.5%");
    expect(formatVariance(0.04)).toBe("0%");
    expect(formatVariance(null)).toBe("—");
  });
});

// Two waves; wave 2 starts after INT-0003. A rejected scan never opens an intake, repeat
// tote scans keep the first open, and a holding bypass (no wave) slots in by scan time.
const scans: RollstockScan[] = [
  { intakeId: "INT-0001", scanId: "s01", scannedAt: "2026-07-20T08:00:00Z", ok: true },
  { intakeId: "INT-0002", scanId: "s02", scannedAt: "2026-07-20T08:05:00Z", ok: true },
  { intakeId: "INT-0001", scanId: "s03", scannedAt: "2026-07-20T08:06:00Z", ok: true },
  { intakeId: "INT-0003", scanId: "s04", scannedAt: "2026-07-20T08:10:00Z", ok: true },
  { intakeId: "INT-0099", scanId: "s05", scannedAt: "2026-07-20T08:11:00Z", ok: false },
  // wave 2
  { intakeId: "INT-0010", scanId: "s06", scannedAt: "2026-07-20T09:00:00Z", ok: true },
  { intakeId: "INT-0011", scanId: "s07", scannedAt: "2026-07-20T09:05:00Z", ok: true },
  { intakeId: "INT-0012", scanId: "s08", scannedAt: "2026-07-20T09:05:00Z", ok: true },
];

describe("rollstock order and hold group (#87)", () => {
  it("V-seq is first accepted rollstock scan per intake, ties by scan id", () => {
    expect(rollstockSequence(scans)).toEqual([
      "INT-0001",
      "INT-0002",
      "INT-0003",
      "INT-0010",
      "INT-0011",
      "INT-0012",
    ]);
    expect(rollstockSequence([...scans].reverse())).toEqual(rollstockSequence(scans));
    expect(() =>
      rollstockSequence([{ intakeId: "x", scanId: "s", scannedAt: "nope", ok: true }]),
    ).toThrow();
  });
  it("V-group is 1 before and 2 after, crossing a wave boundary", () => {
    const sequence = rollstockSequence(scans);
    // INT-0003 is the last of wave 1: its 2 after are wave 2's first two.
    expect(holdGroup(sequence, "INT-0003")).toEqual([
      "INT-0002",
      "INT-0003",
      "INT-0010",
      "INT-0011",
    ]);
    // INT-0010 is the first of wave 2: the 1 before is wave 1's last.
    expect(holdGroup(sequence, "INT-0010")).toEqual([
      "INT-0003",
      "INT-0010",
      "INT-0011",
      "INT-0012",
    ]);
  });
  it("V-group clips at the ends; an intake never opened is a group of one", () => {
    const sequence = rollstockSequence(scans);
    expect(holdGroup(sequence, "INT-0001")).toEqual(["INT-0001", "INT-0002", "INT-0003"]);
    expect(holdGroup(sequence, "INT-0012")).toEqual(["INT-0011", "INT-0012"]);
    expect(holdGroup(sequence, "INT-0099")).toEqual(["INT-0099"]);
    expect(holdGroup([], "INT-0001")).toEqual(["INT-0001"]);
  });
});

describe("sign-off and setting (#87)", () => {
  it("V-signoff reasons are the enum; other needs a note", () => {
    expect(VARIANCE_SIGNOFF_REASONS).toEqual([
      "estimate_wrong",
      "mixed_species",
      "spoilage",
      "trim_heavy",
      "other",
    ]);
    expect(varianceSignoffProblem("spoilage", null)).toBeNull();
    expect(varianceSignoffProblem("other", "  ")).toBe(SIGNOFF_OTHER_NEEDS_NOTE);
    expect(varianceSignoffProblem("other", "bled fish")).toBeNull();
    expect(varianceSignoffProblem("guess", "x")).toBe(SIGNOFF_UNKNOWN_REASON);
    expect(varianceSignoffProblem("spoilage", "x".repeat(501))).toBe(SIGNOFF_NOTE_TOO_LONG);
  });
  it("V-setting defaults to 15 and is a whole percent 1–100 when present", () => {
    expect(VARIANCE_HOLD_PCT_DEFAULT).toBe(15);
    expect(varianceHoldLimit({})).toBe(15);
    expect(varianceHoldLimit({ reconcile: { variance_hold_pct: 20 } })).toBe(20);
    expect(varianceHoldSettingProblem({})).toBeNull();
    for (const pct of [1, 15, 100])
      expect(varianceHoldSettingProblem({ reconcile: { variance_hold_pct: pct } })).toBeNull();
    for (const reconcile of [
      { variance_hold_pct: 0 },
      { variance_hold_pct: 101 },
      { variance_hold_pct: 12.5 },
      { variance_hold_pct: "15" },
      { variance_hold_pct: 15, extra: 1 },
      {},
      null,
      [15],
    ])
      expect(varianceHoldSettingProblem({ reconcile })).toBe(VARIANCE_SETTING_PROBLEM);
  });
});

describe("generated variance SQL", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  it(`${VARIANCE_SQL_PATH} is up to date (run \`pnpm --filter rules gen:sql\`)`, () => {
    expect(readFileSync(resolve(repoRoot, VARIANCE_SQL_PATH), "utf8")).toBe(renderVarianceSql());
  });
  it("renders every reason and message from variance.ts", () => {
    const sql = renderVarianceSql();
    for (const text of [
      ...VARIANCE_SIGNOFF_REASONS,
      SIGNOFF_OTHER_NEEDS_NOTE,
      SIGNOFF_UNKNOWN_REASON,
      VARIANCE_SETTING_PROBLEM,
    ])
      expect(sql).toContain(text);
  });
});
