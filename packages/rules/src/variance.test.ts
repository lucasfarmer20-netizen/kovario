import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { variancePercent } from "./reconcile";
import { STATES } from "./states";
import {
  actualFrozen,
  exceedsVarianceHold,
  formatVariance,
  holdWaitingMessage,
  holdWaitingOn,
  holdWaitText,
  joinWaitTexts,
  type HoldGroupMember,
  holdBlocks,
  holdGroup,
  holdJudgement,
  holdReevaluateOn,
  memberKeepsHoldOpen,
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
import {
  HOLD_REEVALUATE_SQL_PATH,
  HOLD_WAIT_SQL_PATH,
  renderHoldReevaluateSql,
  renderHoldWaitSql,
  renderVarianceSql,
  VARIANCE_SQL_PATH,
} from "./variance-sql";

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
  it("#94 one variance text: whole numbers carry no decimal, one decimal at most", () => {
    expect(formatVariance(40)).toBe("+40%");
    expect(formatVariance(40.0)).toBe("+40%");
    expect(formatVariance(-40)).toBe("−40%");
    expect(formatVariance(3.5)).toBe("+3.5%");
    expect(formatVariance(39.96)).toBe("+40%");
    expect(formatVariance(0)).toBe("0%");
    expect(formatVariance(-0.04)).toBe("0%");
    expect(formatVariance(variancePercent(140, 100))).toBe("+40%");
    expect(formatVariance(variancePercent(140, 0))).toBe("—");
  });
  it("#94 the generated app.format_variance is built from the same text", () => {
    const sql = renderVarianceSql();
    expect(sql).toContain("when p_pct is null then '—'");
    expect(sql).toContain("when t.tenths = 0 then '0%'");
    expect(sql).toContain("case when p_pct > 0 then '+' else '−' end");
    expect(sql).not.toMatch(/to_char|\.0%/);
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

describe("hold states (#87)", () => {
  it("V-states a hold blocks every intake not yet sent to blast", () => {
    expect(STATES.intake.filter(holdBlocks)).toEqual([
      "draft",
      "holding",
      "processing",
      "rollstock",
      "reconcile",
    ]);
    expect(STATES.intake.filter(actualFrozen)).toEqual(["blast_freezer", "stored", "done"]);
  });
  it("V-open only members whose weight can still change keep a hold open", () => {
    for (const state of ["processing", "rollstock"] as const)
      expect(memberKeepsHoldOpen(state, "within", false)).toBe(true);
    expect(memberKeepsHoldOpen("reconcile", "over", false)).toBe(true);
    expect(memberKeepsHoldOpen("reconcile", "over", true)).toBe(false);
    expect(memberKeepsHoldOpen("reconcile", "near", false)).toBe(false);
    expect(memberKeepsHoldOpen("reconcile", "unknown", false)).toBe(false);
    for (const state of ["blast_freezer", "stored", "done", "cancelled"] as const)
      expect(memberKeepsHoldOpen(state, "over", false)).toBe(false);
  });
});

describe("hold re-evaluation (#95)", () => {
  const bands = ["within", "near", "over", "unknown"] as const;
  it("I95 a member's judgement is all memberKeepsHoldOpen reads from its state", () => {
    for (const a of STATES.intake)
      for (const b of STATES.intake.filter((s) => holdJudgement(s) === holdJudgement(a)))
        for (const band of bands)
          for (const signedOff of [false, true])
            expect(memberKeepsHoldOpen(a, band, signedOff), `${a} ${b} ${band}`).toBe(
              memberKeepsHoldOpen(b, band, signedOff),
            );
  });
  it("I95 entering or leaving reconcile and cancelling before it re-evaluate holds", () => {
    expect(holdReevaluateOn("rollstock", "reconcile")).toBe(true);
    expect(holdReevaluateOn("reconcile", "blast_freezer")).toBe(true);
    expect(holdReevaluateOn("blast_freezer", "reconcile")).toBe(true);
    expect(holdReevaluateOn("reconcile", "cancelled")).toBe(true);
    for (const from of ["draft", "holding", "processing", "rollstock"] as const)
      expect(holdReevaluateOn(from, "cancelled"), from).toBe(true);
  });
  it("I95 a change within one judgement re-evaluates nothing", () => {
    expect(holdReevaluateOn("processing", "rollstock")).toBe(false);
    expect(holdReevaluateOn("blast_freezer", "stored")).toBe(false);
    expect(holdReevaluateOn("stored", "done")).toBe(false);
    expect(holdReevaluateOn("blast_freezer", "cancelled")).toBe(false);
    expect(holdReevaluateOn("stored", "cancelled")).toBe(false);
    for (const s of STATES.intake) expect(holdReevaluateOn(s, s), s).toBe(false);
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

describe("what a hold waits on (#93, DECISION-27)", () => {
  const m = (
    number: string,
    state: HoldGroupMember["state"],
    band: HoldGroupMember["band"],
    variancePct: number | null,
    actualLb = 50,
    signedOffAtCurrentWeight = false,
  ): HoldGroupMember => ({
    intakeId: number,
    number,
    state,
    band,
    actualLb,
    variancePct,
    signedOffAtCurrentWeight,
  });
  const group = [
    m("INT-0001", "blast_freezer", "within", 2),
    m("INT-0002", "reconcile", "within", 3),
    m("INT-0003", "rollstock", "unknown", null, 0),
    m("INT-0004", "reconcile", "over", 22),
  ];

  it("I93 lists the other members keeping the hold open, in rollstock order, with why", () => {
    expect(holdWaitingOn(group, "INT-0002")).toEqual([
      { number: "INT-0003", reason: "not_at_reconcile", variancePct: null },
      { number: "INT-0004", reason: "over_limit", variancePct: 22 },
    ]);
  });
  it("I93 names the issue's example: within, waiting on a neighbour upstream and one over", () => {
    expect(holdWaitingMessage("INT-0002", "within", holdWaitingOn(group, "INT-0002"))).toBe(
      "INT-0002 is within the limit. Hold waits on INT-0003 (not at reconcile yet) and INT-0004 (+22%). It clears when they are at reconcile within the limit, or a manager signs off.",
    );
  });
  it("I93 near is still within the limit; no estimate says so instead", () => {
    const waits = holdWaitingOn(group, "INT-0002");
    expect(holdWaitingMessage("INT-0002", "near", waits)).toMatch(
      /^INT-0002 is within the limit\./,
    );
    expect(holdWaitingMessage("INT-0002", "unknown", waits)).toMatch(
      /^INT-0002 has no expected yield to compare\. Hold waits on INT-0003/,
    );
  });
  it("I93 over the limit is not a waiting message (that refusal names its own variance)", () => {
    expect(holdWaitingMessage("INT-0004", "over", [])).toBeNull();
  });
  it("I93 nothing left waiting: Send to Blast clears the hold", () => {
    expect(holdWaitingMessage("INT-0002", "within", [])).toBe(
      "INT-0002 is within the limit. The rest of its hold group is within the limit too. Send to Blast clears the hold.",
    );
  });
  it("I93 never judges the flagged order itself, signed-off, past-reconcile or cancelled members", () => {
    const quiet = [
      m("INT-0002", "reconcile", "over", 40),
      m("INT-0005", "reconcile", "over", 30, 65, true),
      m("INT-0006", "stored", "over", 50),
      m("INT-0007", "cancelled", "unknown", null),
    ];
    expect(holdWaitingOn(quiet, "INT-0002")).toEqual([]);
  });
  it("I93 a member at reconcile with nothing weighed is 'not weighed yet', not −100%", () => {
    const [wait] = holdWaitingOn([m("INT-0003", "reconcile", "over", -100, 0)], "INT-0002");
    expect(holdWaitText(wait!)).toBe("INT-0003 (not weighed yet)");
    expect(holdWaitText({ number: "INT-0004", reason: "over_limit", variancePct: -18.25 })).toBe(
      "INT-0004 (−18.3%)",
    );
  });
  it("I93 joins one, two and many", () => {
    expect(joinWaitTexts([])).toBe("");
    expect(joinWaitTexts(["A"])).toBe("A");
    expect(joinWaitTexts(["A", "B"])).toBe("A and B");
    expect(joinWaitTexts(["A", "B", "C"])).toBe("A, B and C");
  });
});

describe("generated hold-wait SQL (#93)", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  it(`${HOLD_WAIT_SQL_PATH} is up to date (run \`pnpm --filter rules gen:sql\`)`, () => {
    expect(readFileSync(resolve(repoRoot, HOLD_WAIT_SQL_PATH), "utf8")).toBe(renderHoldWaitSql());
  });
});

describe("generated hold re-evaluation SQL (#95)", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  it(`${HOLD_REEVALUATE_SQL_PATH} is up to date (run \`pnpm --filter rules gen:sql\`)`, () => {
    expect(readFileSync(resolve(repoRoot, HOLD_REEVALUATE_SQL_PATH), "utf8")).toBe(
      renderHoldReevaluateSql(),
    );
  });
});
