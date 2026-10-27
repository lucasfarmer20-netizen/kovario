import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BUY_BLOCKER_MISSING_SHIP_DATE,
  BUY_BLOCKER_NO_SERVICE,
  LBS_LEFT_NEGATIVE,
  LBS_LEFT_NOT_A_NUMBER,
  LBS_LEFT_NOT_LESS_THAN_MEASURE,
  LBS_LEFT_ON_UNTICKED,
  LBS_LEFT_TOO_PRECISE,
  releaseLineIssue,
  shipmentBuyGate,
  vesselReleaseAction,
  type BuyGateInput,
} from "./release";
import { RELEASE_SQL_PATH, renderReleaseSql } from "./release-sql";

describe("I4/I5 vessel line", () => {
  it("I5 ticked, Lbs Left 0 or blank → full pull", () => {
    expect(vesselReleaseAction(true, 0, 30)).toBe("full_pull");
    expect(vesselReleaseAction(true, null, 30)).toBe("full_pull");
  });

  it("I5 ticked, 0 < Lbs Left < measure → split", () => {
    expect(vesselReleaseAction(true, 12.5, 30)).toBe("split");
    expect(vesselReleaseAction(true, 29.99, 30)).toBe("split");
  });

  it("I5 split at or above the current measure is a hard error", () => {
    expect(releaseLineIssue(true, 30, 30)).toBe(LBS_LEFT_NOT_LESS_THAN_MEASURE);
    expect(() => vesselReleaseAction(true, 31, 30)).toThrow(LBS_LEFT_NOT_LESS_THAN_MEASURE);
  });

  it("I16 negative or non-numeric Lbs Left is an input fault", () => {
    expect(releaseLineIssue(true, -1, 30)).toBe(LBS_LEFT_NEGATIVE);
    expect(releaseLineIssue(false, -1, 30)).toBe(LBS_LEFT_NEGATIVE);
    expect(releaseLineIssue(true, Number.NaN, 30)).toBe(LBS_LEFT_NOT_A_NUMBER);
    expect(releaseLineIssue(true, Number.POSITIVE_INFINITY, 30)).toBe(LBS_LEFT_NOT_A_NUMBER);
  });

  it("I5 Lbs Left is in hundredths: a finer remainder is rejected, never rounded into a split", () => {
    expect(releaseLineIssue(true, 0.004, 30)).toBe(LBS_LEFT_TOO_PRECISE);
    expect(releaseLineIssue(true, 29.996, 30)).toBe(LBS_LEFT_TOO_PRECISE);
    expect(releaseLineIssue(false, 0.001, 30)).toBe(LBS_LEFT_TOO_PRECISE);
    expect(releaseLineIssue(true, 0.29, 30)).toBeNull();
    expect(releaseLineIssue(true, 29.99, 30)).toBeNull();
  });

  it("P19 unticked line with a remainder is rejected, never an action (I4/I5)", () => {
    expect(releaseLineIssue(false, 5, 30)).toBe(LBS_LEFT_ON_UNTICKED);
    expect(() => vesselReleaseAction(false, 5, 30)).toThrow(LBS_LEFT_ON_UNTICKED);
    expect(vesselReleaseAction(false, 0, 30)).toBe("none");
    expect(vesselReleaseAction(false, null, 30)).toBe("none");
  });

  it("I4 the tick alone selects: no remainder ever makes an unticked line act", () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: true }),
        fc.double({ min: 0, max: 500, noNaN: true }),
        (l, m) => {
          const issue = releaseLineIssue(false, l, m);
          if (issue === null) expect(vesselReleaseAction(false, l, m)).toBe("none");
          else expect(l).not.toBe(0);
        },
      ),
    );
  });
});

describe("I13 shipment buy gate", () => {
  const base: BuyGateInput = {
    shipDate: "2026-07-21",
    today: "2026-07-20",
    buyWindowDays: 1,
    forceBuyHeld: false,
    service: "usps_priority",
    blockers: [],
    labelBought: false,
  };

  it("I13 buy iff ship_date ≤ today + 1", () => {
    expect(shipmentBuyGate(base)).toEqual({
      held: false,
      blockers: [],
      canBuy: true,
      canReprint: false,
    });
    expect(shipmentBuyGate({ ...base, shipDate: "2026-07-20" }).canBuy).toBe(true);
  });

  it("P10 ship box 2+ days out is held (info), not blocked", () => {
    const gate = shipmentBuyGate({ ...base, shipDate: "2026-07-22" });
    expect(gate).toEqual({ held: true, blockers: [], canBuy: false, canReprint: false });
  });

  it("P11 held AND a real blocker are both reported (I13b)", () => {
    const gate = shipmentBuyGate({
      ...base,
      shipDate: "2026-07-25",
      service: null,
      blockers: ["bad_address"],
    });
    expect(gate.held).toBe(true);
    expect(gate.blockers).toEqual(["bad_address", BUY_BLOCKER_NO_SERVICE]);
    expect(gate.canBuy).toBe(false);
  });

  it("P12 manager Buy Now overrides the hold but preserves non-date blockers (I14)", () => {
    expect(shipmentBuyGate({ ...base, shipDate: "2026-07-25", forceBuyHeld: true })).toEqual({
      held: false,
      blockers: [],
      canBuy: true,
      canReprint: false,
    });
    const blocked = shipmentBuyGate({
      ...base,
      shipDate: "2026-07-25",
      forceBuyHeld: true,
      blockers: ["bad_address"],
    });
    expect(blocked).toMatchObject({ held: false, blockers: ["bad_address"], canBuy: false });
  });

  it("P23 a missing ship date blocks the buy explicitly, even under Buy Now", () => {
    for (const forceBuyHeld of [false, true]) {
      expect(shipmentBuyGate({ ...base, shipDate: null, forceBuyHeld })).toEqual({
        held: false,
        blockers: [BUY_BLOCKER_MISSING_SHIP_DATE],
        canBuy: false,
        canReprint: false,
      });
    }
  });

  it("P24 reprinting an already-bought future-dated label is always allowed", () => {
    expect(shipmentBuyGate({ ...base, shipDate: "2026-08-30", labelBought: true })).toEqual({
      held: false,
      blockers: [],
      canBuy: false,
      canReprint: true,
    });
  });

  it("I13 month boundaries and a wider window", () => {
    const edge = { ...base, today: "2026-07-31", shipDate: "2026-08-01" };
    expect(shipmentBuyGate(edge).held).toBe(false);
    expect(shipmentBuyGate({ ...edge, shipDate: "2026-08-02" }).held).toBe(true);
    expect(shipmentBuyGate({ ...edge, shipDate: "2026-08-03", buyWindowDays: 3 }).held).toBe(false);
  });

  it("rejects malformed dates and windows", () => {
    expect(() => shipmentBuyGate({ ...base, today: "07/20/2026" })).toThrow(/ISO date/);
    expect(() => shipmentBuyGate({ ...base, buyWindowDays: -1 })).toThrow(/buyWindowDays/);
  });
});

describe("generated release SQL", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

  it(`${RELEASE_SQL_PATH} is up to date (run \`pnpm --filter rules gen:sql\`)`, () => {
    const committed = readFileSync(resolve(repoRoot, RELEASE_SQL_PATH), "utf8");
    expect(committed.replaceAll("\r\n", "\n")).toBe(renderReleaseSql());
  });

  it("carries the rule messages verbatim", () => {
    const sql = renderReleaseSql();
    for (const message of [LBS_LEFT_ON_UNTICKED, LBS_LEFT_NOT_LESS_THAN_MEASURE]) {
      expect(sql).toContain(message.replaceAll("'", "''"));
    }
  });
});
