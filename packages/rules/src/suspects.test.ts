import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { STATES, canTransition, nextStates } from "./states";
import {
  PULL_BACK_NEEDS_REASON,
  PULL_BACK_NOT_IN_BLAST,
  PULL_BACK_REASON_MAX,
  PULL_BACK_REASON_TOO_LONG,
  binMovable,
  pullBackProblem,
  rankSuspects,
  suggestMoves,
  suspectStatus,
  suspectWaiting,
  suspectsWaiting,
  type Suspect,
  type SuspectBin,
} from "./suspects";
import { renderSuspectsSql, SUSPECTS_SQL_PATH } from "./suspects-sql";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function member(
  number: string,
  position: number,
  actualLb: number,
  expectedLb = 50,
  species: string[] = ["salmon"],
  status: Suspect["status"] = "reconciled",
): Suspect {
  return { intakeId: number, number, position, status, expectedLb, actualLb, species };
}

const numbers = (list: readonly { number: string }[]) => list.map((s) => s.number);

describe("suspect ranking (#88)", () => {
  it("PK1 the opposite-variance neighbour that best cancels the flagged intake ranks first", () => {
    // Flagged +20 lb. INT-B −18 cancels to 2 lb; INT-C −30 leaves 10 lb; INT-D +5 is the same sign.
    const flagged = member("INT-A", 0, 70);
    const ranked = rankSuspects(flagged, [
      flagged,
      member("INT-D", -1, 55),
      member("INT-C", 1, 20),
      member("INT-B", 2, 32),
    ]);
    expect(numbers(ranked)).toEqual(["INT-B", "INT-C", "INT-D"]);
    expect(ranked[0]).toMatchObject({ opposite: true, diffLb: -18, residualLb: 2 });
    expect(ranked[2]).toMatchObject({ opposite: false, residualLb: null });
  });

  it("PK2 an under-weight flagged intake looks for an over-weight suspect", () => {
    const flagged = member("INT-A", 0, 35); // −15 lb
    const ranked = rankSuspects(flagged, [member("INT-B", -1, 40), member("INT-C", 1, 64)]);
    expect(numbers(ranked)).toEqual(["INT-C", "INT-B"]);
    expect(ranked[0]).toMatchObject({ opposite: true, diffLb: 14, residualLb: 1 });
  });

  it("PK3 between equal cancellations, more species in common ranks first", () => {
    const flagged = member("INT-A", 0, 70, 50, ["salmon", "halibut"]);
    const ranked = rankSuspects(flagged, [
      member("INT-B", -1, 30, 50, ["rockfish"]),
      member("INT-C", 1, 30, 50, ["halibut", "salmon"]),
      member("INT-D", 2, 30, 50, ["salmon"]),
    ]);
    expect(numbers(ranked)).toEqual(["INT-C", "INT-D", "INT-B"]);
    expect(ranked.map((s) => s.sharedSpecies)).toEqual([2, 1, 0]);
  });

  it("PK4 then the smaller order (estimated yield) ranks first", () => {
    // Both cancel the flagged +10 lb exactly; INT-C is the small order a missed tote fits.
    const flagged = member("INT-A", 0, 60);
    const ranked = rankSuspects(flagged, [member("INT-B", -1, 190, 200), member("INT-C", 1, 20, 30)]);
    expect(numbers(ranked)).toEqual(["INT-C", "INT-B"]);
  });

  it("PK5 cancellation outranks species overlap and size", () => {
    const flagged = member("INT-A", 0, 70, 50, ["salmon"]);
    const ranked = rankSuspects(flagged, [
      member("INT-B", -1, 25, 30, ["salmon"]), // −5: residual 15, shares species, small
      member("INT-C", 1, 180, 200, ["lingcod"]), // −20: residual 0
    ]);
    expect(numbers(ranked)).toEqual(["INT-C", "INT-B"]);
  });

  it("PK6 a same-sign or zero variance never outranks an opposite one, however small", () => {
    const flagged = member("INT-A", 0, 70);
    const ranked = rankSuspects(flagged, [
      member("INT-B", -1, 50, 10), // +40 same sign, tiny order
      member("INT-C", 1, 50), // 0
      member("INT-D", 2, 49.99, 500), // −0.01, huge order
    ]);
    expect(numbers(ranked)[0]).toBe("INT-D");
  });

  it("PK7 waiting members have no variance yet; they rank after known ones, by species and size", () => {
    const flagged = member("INT-A", 0, 70);
    const ranked = rankSuspects(flagged, [
      member("INT-B", 1, 0, 50, ["salmon"], "upstream"),
      member("INT-C", 2, 0, 20, ["salmon"], "at_reconcile"),
      member("INT-D", -1, 60),
    ]);
    expect(numbers(ranked)).toEqual(["INT-D", "INT-C", "INT-B"]);
    expect(ranked[1]).toMatchObject({ diffLb: null, opposite: false });
  });

  it("PK8 cancelled members and the flagged intake are never suspects; ties keep rollstock order", () => {
    const flagged = member("INT-A", 0, 70);
    const ranked = rankSuspects(flagged, [
      flagged,
      member("INT-X", -1, 30, 50, ["salmon"], "cancelled"),
      member("INT-C", 2, 50),
      member("INT-B", 1, 50),
    ]);
    expect(numbers(ranked)).toEqual(["INT-B", "INT-C"]);
  });

  it("PK9 cancellation is compared exactly in hundredths of a lb", () => {
    const flagged = member("INT-A", 0, 50.3); // +0.30
    const ranked = rankSuspects(flagged, [member("INT-B", -1, 49.8), member("INT-C", 1, 49.6)]);
    // −0.20 leaves 0.10; −0.40 leaves 0.10: a tie broken by species, size, then rollstock order.
    expect(ranked.map((s) => s.residualLb)).toEqual([0.1, 0.1]);
    expect(numbers(ranked)).toEqual(["INT-B", "INT-C"]);
  });

  it("PK10 the ranking is a permutation of the suspects whatever the input order", () => {
    const arb = fc.array(
      fc.record({
        actual: fc.integer({ min: 0, max: 20000 }),
        expected: fc.integer({ min: 0, max: 20000 }),
        species: fc.subarray(["salmon", "halibut", "lingcod"]),
      }),
      { minLength: 1, maxLength: 4 },
    );
    fc.assert(
      fc.property(arb, fc.integer({ min: -9000, max: 9000 }), (rows, flaggedDiff) => {
        const flagged = member("INT-F", 0, Math.max(0, 50 + flaggedDiff / 100));
        const members = rows.map((r, i) =>
          member(`INT-${i}`, i + 1, r.actual / 100, r.expected / 100, r.species),
        );
        const a = rankSuspects(flagged, members);
        const b = rankSuspects(flagged, [...members].reverse());
        expect(numbers(a)).toEqual(numbers(b));
        expect([...numbers(a)].sort()).toEqual(numbers(members).sort());
        const firstOther = a.findIndex((s) => !s.opposite);
        if (firstOther >= 0) expect(a.slice(firstOther).every((s) => !s.opposite)).toBe(true);
      }),
    );
  });
});

describe("suspect status (#88)", () => {
  it("PK-S1 reconciled needs a vessel at reconcile, every one weighed", () => {
    expect(suspectStatus("reconcile", 2, 0)).toBe("reconciled");
    expect(suspectStatus("reconcile", 2, 1)).toBe("at_reconcile");
    expect(suspectStatus("reconcile", 0, 0)).toBe("at_reconcile");
    expect(suspectStatus("rollstock", 3, 0)).toBe("upstream");
    expect(suspectStatus("blast_freezer", 1, 0)).toBe("in_blast");
    expect(suspectStatus("stored", 1, 0)).toBe("stored");
    expect(suspectStatus("done", 0, 0)).toBe("stored");
    expect(suspectStatus("cancelled", 0, 0)).toBe("cancelled");
  });
  it("PK-S2 waiting = not yet reconciled; sent and cancelled members do not wait", () => {
    const waiting = STATES.intake.filter((s) => suspectWaiting(suspectStatus(s, 1, 0)));
    expect(waiting).toEqual(["draft", "holding", "processing", "rollstock"]);
    expect(suspectWaiting(suspectStatus("reconcile", 1, 1))).toBe(true);
    const members = [
      member("INT-C", 2, 0, 50, [], "upstream"),
      member("INT-A", -1, 50),
      member("INT-B", 1, 0, 50, [], "at_reconcile"),
    ];
    expect(numbers(suspectsWaiting(members))).toEqual(["INT-B", "INT-C"]);
  });
});

describe("move suggestions (#88)", () => {
  const bins: SuspectBin[] = [
    { vesselId: "v-a1", intakeId: "INT-A", weightLb: 30 },
    { vesselId: "v-a2", intakeId: "INT-A", weightLb: 18 },
    { vesselId: "v-a3", intakeId: "INT-A", weightLb: 22 },
    { vesselId: "v-b1", intakeId: "INT-B", weightLb: 32 },
  ];

  it("PK-M1 no suggestions while any group intake is unreconciled", () => {
    const flagged = member("INT-A", 0, 70);
    for (const status of ["upstream", "at_reconcile"] as const) {
      const members = [flagged, member("INT-B", 1, 32), member("INT-C", 2, 0, 50, [], status)];
      expect(suggestMoves(flagged, members, bins)).toEqual([]);
    }
    const waitingFlagged = member("INT-A", 0, 0, 50, [], "at_reconcile");
    expect(suggestMoves(waitingFlagged, [member("INT-B", 1, 32)], bins)).toEqual([]);
  });

  it("PK-M2 once all are reconciled, the over intake's best bin goes to the best suspect", () => {
    // INT-A +20, INT-B −18: the 18 lb bin leaves A +2 and B 0.
    const flagged = member("INT-A", 0, 70);
    const moves = suggestMoves(flagged, [flagged, member("INT-B", 1, 32), member("INT-C", 2, 50)], bins);
    expect(moves).toEqual([
      {
        vesselId: "v-a2",
        fromIntakeId: "INT-A",
        toIntakeId: "INT-B",
        weightLb: 18,
        pullBack: [],
        beforeLb: 38,
        afterLb: 2,
      },
    ]);
  });

  it("PK-M3 an under-weight flagged intake takes a bin from the over suspect", () => {
    const flagged = member("INT-A", 0, 20); // −30
    const moves = suggestMoves(flagged, [member("INT-B", 1, 82)], bins); // +32
    expect(moves[0]).toMatchObject({ vesselId: "v-b1", fromIntakeId: "INT-B", toIntakeId: "INT-A" });
  });

  it("PK-M4 a suspect in blast is suggested with a pull back; a stored one is not suggested", () => {
    const flagged = member("INT-A", 0, 70);
    const inBlast = member("INT-B", 1, 32, 50, ["salmon"], "in_blast");
    expect(suggestMoves(flagged, [inBlast], bins)[0]).toMatchObject({ pullBack: ["INT-B"] });
    const stored = member("INT-B", 1, 32, 50, ["salmon"], "stored");
    expect(suggestMoves(flagged, [stored], bins)).toEqual([]);
  });

  it("PK-M5 no move is suggested when no bin brings the pair closer", () => {
    const flagged = member("INT-A", 0, 51); // +1
    const moves = suggestMoves(flagged, [member("INT-B", 1, 49)], bins); // −1, smallest bin 18 lb
    expect(moves).toEqual([]);
  });
});

describe("move bin and pull back (#88)", () => {
  it("PK-P1 a bin moves only between intakes at reconcile", () => {
    expect(STATES.intake.filter(binMovable)).toEqual(["reconcile"]);
  });

  it("PK-P2 pull back is blast_freezer → reconcile, manager only", () => {
    expect(canTransition("intake", "blast_freezer", "reconcile", { isManager: true })).toBe(true);
    expect(canTransition("intake", "blast_freezer", "reconcile")).toBe(false);
    expect(nextStates("intake", "stored", { isManager: true })).not.toContain("reconcile");
  });

  it("PK-P3 pull back needs a reason and an intake in the blast freezer", () => {
    expect(pullBackProblem("blast_freezer", "Wrong bin in INT-0003")).toBeNull();
    expect(pullBackProblem("blast_freezer", "  ")).toBe(PULL_BACK_NEEDS_REASON);
    expect(pullBackProblem("blast_freezer", null)).toBe(PULL_BACK_NEEDS_REASON);
    expect(pullBackProblem("blast_freezer", "x".repeat(PULL_BACK_REASON_MAX + 1))).toBe(
      PULL_BACK_REASON_TOO_LONG,
    );
    for (const state of STATES.intake.filter((s) => s !== "blast_freezer"))
      expect(pullBackProblem(state, "reason")).toBe(PULL_BACK_NOT_IN_BLAST);
  });
});

describe("generated SQL", () => {
  it(`${SUSPECTS_SQL_PATH} is up to date (run \`pnpm --filter rules gen:sql\`)`, () => {
    const committed = readFileSync(resolve(repoRoot, SUSPECTS_SQL_PATH), "utf8");
    expect(committed.replaceAll("\r\n", "\n")).toBe(renderSuspectsSql());
  });
});
