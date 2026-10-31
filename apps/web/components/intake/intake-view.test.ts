import { describe, expect, it } from "vitest";
import { emptyRow, linesPrompt, type LineRow } from "./intake-form-state";
import { intakeNextStep, refusal, savedNextStep } from "./intake-view";
import { pickupNextStep, storageNextStep } from "@/components/storage/storage-view";

// docs/11 prompt grammar on the keyboard stations (#131): the next step line names what the
// form still needs, and Save / Confirm wait with the same words until it is there.
const row = (patch: Partial<LineRow>): LineRow => ({ ...emptyRow(), ...patch });
const SILVERS = row({
  species: "salmon_silvers",
  condition: "whole",
  method: "fresh",
  lb: "50",
  filletsPct: "60",
});

describe("intake next step", () => {
  it("names the first missing field of the first incomplete line; blank lines are skipped", () => {
    expect(linesPrompt([row({})])).toBe("Pick the species for line 1");
    expect(linesPrompt([row({ species: "salmon_silvers" })])).toBe("Pick the condition for line 1");
    expect(linesPrompt([SILVERS, row({ ...SILVERS, lb: "" })])).toBe("Enter the lb for line 2");
    expect(linesPrompt([row({ ...SILVERS, filletsPct: "140" })])).toBe(
      "Enter fillets % (0–100) for line 1",
    );
    expect(linesPrompt([SILVERS, row({})])).toBeNull();
  });

  it("walks customer → lines → Save; Save's reason matches the line", () => {
    const base = { rows: [SILVERS], toteCount: "2", priced: true, online: true };
    const draft = { lines: [], charges: [], missingRates: [] } as never;
    expect(intakeNextStep({ ...base, customer: false, draft })).toMatchObject({
      step: 0,
      saveWhy: "Pick the customer first",
    });
    expect(intakeNextStep({ ...base, customer: true, rows: [row({})], draft: null })).toMatchObject(
      {
        next: "Pick the species for line 1",
        step: 1,
        saveWhy: "Pick the species for line 1 first",
      },
    );
    expect(intakeNextStep({ ...base, customer: true, toteCount: "0", draft })).toMatchObject({
      next: "Enter the tote count",
    });
    expect(intakeNextStep({ ...base, customer: true, draft })).toEqual({
      next: "Tap Save & Print Tote Tags",
      step: 2,
      saveWhy: null,
    });
  });

  it("warns on a missing rate and holds Save; offline, Save waits and says why", () => {
    const base = { customer: true, rows: [SILVERS], toteCount: "1", priced: true };
    const missing = { lines: [], charges: [], missingRates: ["Fillets"] } as never;
    expect(intakeNextStep({ ...base, draft: missing, online: true })).toMatchObject({
      tone: "warn",
      saveWhy: "The rate card has no rate for Fillets",
    });
    const ok = { lines: [], charges: [], missingRates: [] } as never;
    expect(intakeNextStep({ ...base, draft: ok, online: false }).saveWhy).toMatch(
      /^Needs a connection/,
    );
  });

  it("the saved view says to write the number when no tote tag was queued", () => {
    const totes = [{ no: 1, of: 1, qr: "FL:TOTE:INT-0007:1", queued: false }];
    expect(savedNextStep({ number: "INT-0007", totes })).toMatchObject({ tone: "warn" });
    expect(
      savedNextStep({ number: "INT-0007", totes: [{ ...totes[0]!, queued: true }] }).next,
    ).toBe("Tag the totes, then tap New Intake");
  });

  it("a refusal says why, then what to do", () => {
    expect(refusal("Rates changed.", "Tap Save again.")).toBe("Rates changed. Tap Save again.");
  });
});

describe("storage next step", () => {
  const box = (weight: string, description = "") => ({ key: weight, weight, description });
  const base = { location: false, problems: [], online: true };
  it("walks customer → boxes → Confirm, naming the label count", () => {
    expect(storageNextStep({ ...base, customer: false, rows: [box("")] })).toMatchObject({
      step: 0,
      confirmWhy: "Pick the customer first",
    });
    expect(storageNextStep({ ...base, customer: true, rows: [box("")] })).toMatchObject({
      next: "Pick the location, then enter each box",
      step: 1,
      confirmWhy: null,
    });
    expect(storageNextStep({ ...base, customer: true, rows: [box("20"), box("")] })).toEqual({
      next: "Tap Confirm & Print 2 Labels",
      step: 2,
      confirmWhy: null,
    });
  });
  it("a bad weight warns and holds Confirm", () => {
    const problems = ["Box 1: weight must be a number of lb (0 or more)."];
    expect(storageNextStep({ ...base, problems, customer: true, rows: [box("x")] })).toMatchObject({
      next: problems[0],
      tone: "warn",
      confirmWhy: "Fix the box first",
    });
  });
  it("pickup: tick → create the batch → charge at the register", () => {
    expect(pickupNextStep(0, false)).toEqual({ next: "Tick each box going home", step: 0 });
    expect(pickupNextStep(2, true)).toEqual({ next: "Tap Create Pickup Batch", step: 1 });
    expect(pickupNextStep(0, true)).toEqual({
      next: "Charge the pickup at the register",
      step: 2,
    });
  });
});
