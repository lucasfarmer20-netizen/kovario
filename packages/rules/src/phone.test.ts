import { describe, expect, it } from "vitest";
import { MIN_SEARCH_DIGITS, formatPhone, normalizePhone, phoneDigits } from "./phone.ts";

describe("phoneDigits", () => {
  it("keeps only digits", () => {
    expect(phoneDigits("(907) 555-1234")).toBe("9075551234");
    expect(phoneDigits("+1 907.555")).toBe("1907555");
    expect(phoneDigits("abc")).toBe("");
  });
});

describe("normalizePhone — typed input → E.164", () => {
  it("reads 10 and 11 digit numbers as NANP", () => {
    for (const raw of [
      "(907) 555-1234",
      "907-555-1234",
      "907.555.1234",
      "9075551234",
      "1 907 555 1234",
      "1-907-555-1234",
      "+1 (907) 555-1234",
      "  +19075551234 ",
    ]) {
      expect(normalizePhone(raw), raw).toBe("+19075551234");
    }
  });

  it("keeps a foreign country code after +", () => {
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("+49 30 123456")).toBe("+4930123456");
  });

  it("rejects partial or impossible numbers", () => {
    for (const raw of [
      "",
      "907",
      "907555",
      "(907) 555-",
      "907555123",
      "90755512345",
      "29075551234",
      "1075551234",
      "9071551234",
      "+1907555",
      "+1 107 555 1234",
      "+0441234567",
      "+1234567",
      "+1234567890123456",
      "+",
    ]) {
      expect(normalizePhone(raw), raw).toBeNull();
    }
  });
});

describe("formatPhone", () => {
  it("formats NANP numbers for display and leaves others E.164", () => {
    expect(formatPhone("+19075551234")).toBe("(907) 555-1234");
    expect(formatPhone("+442079460958")).toBe("+442079460958");
  });
});

it("search starts at 3 digits (docs/06-STATIONS-UX.md, Intake)", () => {
  expect(MIN_SEARCH_DIGITS).toBe(3);
});
