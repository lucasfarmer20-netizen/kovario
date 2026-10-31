import { describe, expect, it } from "vitest";
import { LBS_LEFT_ON_UNTICKED } from "rules";
import {
  boxingPrompt,
  completePayload,
  completeWhy,
  emptyTicks,
  I8_TOTE_LEFT_HINT,
  lineIssues,
  nothingTicked,
  reproject,
  scanTick,
  setLbsLeft,
  tickBoxes,
  toggleBox,
  toggleVessel,
  type Wizard,
  type WizardVessel,
} from "./boxing-state";

const vessel = (id: string, tag: string | null, lb: number, seq: number): WizardVessel => ({
  vessel_id: id,
  intake_id: "i1",
  intake_number: "INT-0001",
  tag_code: tag,
  is_exchange: tag === null,
  weight_lb: lb,
  species_summary: "Silvers",
  location_code: null,
  walk_seq: seq,
});

const wizard = (over: Partial<Wizard> = {}): Wizard => ({
  session_id: "s1",
  number: "ALC-0001",
  state: "priced",
  party_name: "Pat",
  moved_before: false,
  finalized_count: 0,
  anglers: [{ settlement_id: "st1", number: "STL-0001", angler_name: "Ann", state: "draft" }],
  boxes: [
    {
      box_id: "b1",
      number: "BOX-0001",
      settlement_id: "st1",
      angler_name: "Ann",
      method: "willcall",
      size: "M",
      weight_lb: 20,
      shipment_number: null,
      ship_date: null,
    },
    {
      box_id: "b2",
      number: "BOX-0002",
      settlement_id: "st1",
      angler_name: "Ann",
      method: "air",
      size: "M",
      weight_lb: 20,
      shipment_number: null,
      ship_date: null,
    },
  ],
  vessels: [vessel("v1", "042", 30, 1), vessel("v2", "043", 20, 2), vessel("vx", null, 12, 3)],
  intakes: [],
  ...over,
});

describe("boxing ticks", () => {
  it("I1 box ticks and tote ticks are independent in the payload", () => {
    const w = wizard();
    let t = toggleBox(emptyTicks(), "b1");
    expect(completePayload(w, t)).toEqual({ box_ticks: ["b1"], vessel_ticks: [] });
    t = toggleVessel(emptyTicks(), w.vessels[0]!);
    expect(completePayload(w, t)).toEqual({
      box_ticks: [],
      vessel_ticks: [{ vessel_id: "v1", lbs_left: null, ticked: true, measure: 30 }],
    });
  });

  it("I4 typing Lbs Left never ticks the tote", () => {
    const w = wizard();
    const t = setLbsLeft(emptyTicks(), w.vessels[0]!, "10");
    expect(t.vessels.v1).toMatchObject({ ticked: false, lbsLeft: "10" });
    expect(nothingTicked(completePayload(w, t))).toBe(true);
  });

  it("P19 an unticked remainder is rejected before Complete and still sent for the server to reject", () => {
    const w = wizard();
    const t = setLbsLeft(emptyTicks(), w.vessels[1]!, "5");
    expect(lineIssues(w, t)).toEqual([
      { vesselId: "v2", message: `Basket 043 (INT-0001): ${LBS_LEFT_ON_UNTICKED}` },
    ]);
    expect(completePayload(w, t).vessel_ticks).toEqual([
      { vessel_id: "v2", lbs_left: 5, ticked: false, measure: 20 },
    ]);
  });

  it("I5 unticking clears the remainder", () => {
    const w = wizard();
    let t = toggleVessel(emptyTicks(), w.vessels[0]!);
    t = setLbsLeft(t, w.vessels[0]!, "12");
    t = toggleVessel(t, w.vessels[0]!);
    expect(t.vessels.v1).toEqual({ ticked: false, lbsLeft: "", measure: 30 });
    expect(lineIssues(w, t)).toEqual([]);
  });

  it("I5 a split must be below the current weight; garbage never becomes a full pull", () => {
    const w = wizard();
    let t = setLbsLeft(toggleVessel(emptyTicks(), w.vessels[0]!), w.vessels[0]!, "30");
    expect(lineIssues(w, t)[0]!.message).toMatch(/less than/);
    t = setLbsLeft(t, w.vessels[0]!, "abc");
    expect(lineIssues(w, t)[0]!.message).toMatch(/number/);
    expect(() => completePayload(w, t)).toThrow(/fix Lbs Left/);
  });
});

describe("scans", () => {
  it("I1 a tag scan ticks its tote, padded or not, and never a box", () => {
    const w = wizard();
    const out = scanTick(w, emptyTicks(), "42");
    expect(out).toMatchObject({ kind: "ticked", message: "Ticked Basket 042 (INT-0001)" });
    if (out.kind !== "ticked") throw new Error("expected a tick");
    expect(out.ticks.boxes).toEqual([]);
    expect(out.ticks.vessels.v1?.ticked).toBe(true);
  });

  it("#85 a 3-digit label ticks its re-padded 4-digit tag", () => {
    const w = wizard({ vessels: [vessel("v1", "0042", 20, 1)] });
    const out = scanTick(w, emptyTicks(), "FL:TAG:rel-a:042");
    expect(out).toMatchObject({ kind: "ticked", message: "Ticked Basket 0042 (INT-0001)" });
  });

  it("I17 a tag outside the party's pick list is rejected", () => {
    expect(scanTick(wizard(), emptyTicks(), "FL:TAG:rel-a:999")).toMatchObject({
      kind: "rejected",
      message: "Basket 999 is not on ALC-0001's pick list",
    });
  });

  it("I11 a boxing QR is handed back to the screen to check the party", () => {
    expect(scanTick(wizard(), emptyTicks(), "FL:BOX:abc123")).toEqual({
      kind: "box",
      token: "abc123",
    });
  });
});

describe("P15 additive re-scan keeps ticks only for still-eligible records (I15)", () => {
  it("drops finalised boxes and freed vessels with a notice; keeps the rest", () => {
    const before = wizard();
    let t = toggleBox(toggleBox(emptyTicks(), "b1"), "b2");
    t = toggleVessel(toggleVessel(t, before.vessels[0]!), before.vessels[1]!);
    t = setLbsLeft(t, before.vessels[1]!, "5");
    const after = wizard({
      boxes: before.boxes.slice(1),
      vessels: [before.vessels[1]!, before.vessels[2]!],
    });
    const r = reproject(before, t, after);
    expect(r.ticks.boxes).toEqual(["b2"]);
    expect(Object.keys(r.ticks.vessels)).toEqual(["v2"]);
    expect(r.ticks.vessels.v2).toEqual({ ticked: true, lbsLeft: "5", measure: 20 });
    expect(r.notices).toEqual([
      "BOX-0001 is no longer planned (finalised elsewhere); its tick was dropped.",
      "Basket 042 (INT-0001) is no longer in the freezer (released elsewhere); dropped.",
    ]);
  });

  it("a refresh can never turn a split into a full pull: a changed basket must be re-selected", () => {
    const before = wizard();
    const t = setLbsLeft(toggleVessel(emptyTicks(), before.vessels[0]!), before.vessels[0]!, "10");
    const after = wizard({ vessels: [{ ...before.vessels[0]!, weight_lb: 15 }] });
    const r = reproject(before, t, after);
    expect(r.ticks.vessels.v1).toBeUndefined(); // tick AND remainder dropped
    expect(r.notices[0]).toMatch(/now holds 15 lb; its tick was dropped/);
    const payload = completePayload(after, r.ticks);
    expect(payload.vessel_ticks).toEqual([]); // nothing is sent, least of all lbs_left null
    expect(nothingTicked(payload)).toBe(true);
    // Re-ticking starts from the weight now shown.
    expect(toggleVessel(r.ticks, after.vessels[0]!).vessels.v1).toEqual({
      ticked: true,
      lbsLeft: "",
      measure: 15,
    });
  });

  it("a ticked full-pull line on a changed basket is dropped too, not re-aimed at the new weight", () => {
    const before = wizard();
    const t = toggleVessel(emptyTicks(), before.vessels[0]!);
    const after = wizard({ vessels: [{ ...before.vessels[0]!, weight_lb: 15 }] });
    expect(completePayload(after, reproject(before, t, after).ticks).vessel_ticks).toEqual([]);
  });
});

describe("boxing prompt (docs/11 Boxing)", () => {
  it("#98 walks open order → tick each box and basket → Complete", () => {
    const w = wizard();
    expect(boxingPrompt(null, emptyTicks())).toEqual({
      next: "Scan the boxing QR or tap an order",
      step: 0,
    });
    expect(boxingPrompt(w, emptyTicks())).toEqual({ next: "Tick each box and basket", step: 1 });
    expect(boxingPrompt(w, toggleBox(emptyTicks(), "b1"))).toEqual({ next: "Complete", step: 2 });
    expect(boxingPrompt(w, toggleVessel(emptyTicks(), w.vessels[0]!)).step).toBe(2);
  });

  it("#130 a party with nothing left goes back to opening the next one", () => {
    expect(boxingPrompt(wizard({ boxes: [], vessels: [] }), emptyTicks()).step).toBe(0);
  });

  it("#130 an I8 refusal leads the line as a warning", () => {
    const w = wizard();
    const t = toggleBox(emptyTicks(), "b1");
    expect(boxingPrompt(w, t, "tote_left")).toEqual({
      next: I8_TOTE_LEFT_HINT,
      step: 1,
      tone: "warn",
    });
    expect(boxingPrompt(w, t, "override").tone).toBe("warn");
  });
});

describe("why Complete waits (docs/11: disabled buttons say why)", () => {
  const base = { wizard: wizard(), validating: 0, online: true };
  it("I7 nothing ticked waits, with the reason", () => {
    expect(completeWhy({ ...base, ticks: emptyTicks() })).toMatch(/^Nothing ticked yet/);
    expect(completeWhy({ ...base, ticks: toggleBox(emptyTicks(), "b1") })).toBeNull();
  });
  it("I5 a line fault waits before anything else is judged", () => {
    const ticks = setLbsLeft(toggleBox(emptyTicks(), "b1"), base.wizard.vessels[0]!, "5");
    expect(completeWhy({ ...base, ticks })).toBe("Fix Lbs left on the pick list first");
  });
  it("offline and scans in flight say so first", () => {
    const ticks = toggleBox(emptyTicks(), "b1");
    expect(completeWhy({ ...base, ticks, online: false })).toBe("Offline. Reconnect to Complete.");
    expect(completeWhy({ ...base, ticks, validating: 1 })).toMatch(/scan is still being checked/);
  });
});

describe("Tick every box", () => {
  it("I1 I3 ticks each listed box once and never a basket", () => {
    const t = tickBoxes(toggleBox(emptyTicks(), "b1"), ["b1", "b2"]);
    expect(t.boxes).toEqual(["b1", "b2"]);
    expect(t.vessels).toEqual({});
  });
});
