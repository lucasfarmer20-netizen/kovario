import { describe, expect, it } from "vitest";
import {
  KeystrokeTimer,
  SCAN_MAX_GAP_MS,
  canSearch,
  createDraft,
  moveHighlight,
  validateDraft,
} from "./customer-search-state";

describe("canSearch — phone first, >= 3 digits", () => {
  it("searches partial and formatted phones once 3 digits are in", () => {
    for (const q of ["907", "(907) 555-", "907555", "+1907", "+1 (907) 555-1234", "555-1234"]) {
      expect(canSearch(q), q).toBe(true);
    }
  });

  it("waits below 3 digits, and needs 3 letters for a name", () => {
    for (const q of ["", "9", "90", "(9", "+1", "(90) -", "al", "a1"]) {
      expect(canSearch(q), q).toBe(false);
    }
    expect(canSearch("ali")).toBe(true);
    expect(canSearch("Ørjan")).toBe(true);
  });

  it("never searches a scanned QR payload", () => {
    expect(canSearch("KV:TOTE:INT-0001:1")).toBe(false);
    expect(canSearch("kv:tag:demo:042")).toBe(false);
  });
});

describe("moveHighlight — keyboard navigation", () => {
  it("wraps in both directions", () => {
    expect(moveHighlight(-1, 3, 1)).toBe(0);
    expect(moveHighlight(-1, 3, -1)).toBe(2);
    expect(moveHighlight(2, 3, 1)).toBe(0);
    expect(moveHighlight(0, 3, -1)).toBe(2);
    expect(moveHighlight(1, 3, 1)).toBe(2);
  });

  it("has nothing to highlight in an empty list", () => {
    expect(moveHighlight(0, 0, 1)).toBe(-1);
  });
});

describe("inline create", () => {
  it("prefills the phone from digits and the name from text", () => {
    expect(createDraft(" (907) 555-12 ")).toEqual({ name: "", phone: "(907) 555-12" });
    expect(createDraft("Dana ")).toEqual({ name: "Dana", phone: "" });
  });

  it("normalises the phone to E.164 and rejects partial numbers", () => {
    expect(validateDraft({ name: " Dana ", phone: "(907) 555-1234" })).toEqual({
      ok: true,
      name: "Dana",
      phone: "+19075551234",
    });
    expect(validateDraft({ name: "Dana", phone: " " })).toEqual({
      ok: true,
      name: "Dana",
      phone: "",
    });
    expect(validateDraft({ name: "Dana", phone: "907555" })).toMatchObject({ ok: false });
    expect(validateDraft({ name: " ", phone: "9075551234" })).toMatchObject({ ok: false });
  });
});

describe("KeystrokeTimer — scanner-safe Enter", () => {
  const typed = (gaps: number[]) => {
    const t = new KeystrokeTimer();
    let at = 1000;
    t.key(at);
    for (const g of gaps) t.key((at += g));
    return t;
  };

  it("treats a fast burst + Enter as a scan", () => {
    expect(typed([5, 6, 4, 8, 5]).isScan("INT-0001")).toBe(true);
    expect(typed([SCAN_MAX_GAP_MS, SCAN_MAX_GAP_MS, SCAN_MAX_GAP_MS]).isBurst()).toBe(true);
  });

  it("treats human typing + Enter as a choice", () => {
    expect(typed([120, 90, 150, 110]).isScan("9075")).toBe(false);
    expect(typed([5, 5, 200, 5]).isScan("9075")).toBe(false);
    expect(typed([5, 5]).isScan("907")).toBe(false);
  });

  it("treats a QR payload as a scan however it was typed", () => {
    expect(typed([300, 300]).isScan("KV:TAG:demo:042")).toBe(true);
  });

  it("starts over after reset", () => {
    const t = typed([5, 5, 5, 5]);
    t.reset();
    t.key(0);
    expect(t.isBurst()).toBe(false);
  });
});
