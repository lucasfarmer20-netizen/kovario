import { describe, expect, it } from "vitest";
import { normalisePairingCode, PAIRING_CODE_PATTERN, pairingUrl } from "./pairing";

describe("pairing", () => {
  it("builds the /pair URL with the code", () => {
    expect(pairingUrl("http://localhost:3000", "ABCD2345")).toBe(
      "http://localhost:3000/pair?code=ABCD2345",
    );
  });

  it("normalises typed codes", () => {
    expect(normalisePairingCode(" abcd-2345 ")).toBe("ABCD2345");
  });

  it("accepts only the unambiguous alphabet", () => {
    expect(PAIRING_CODE_PATTERN.test("ABCD2345")).toBe(true);
    expect(PAIRING_CODE_PATTERN.test("ABCD0OIL")).toBe(false);
    expect(PAIRING_CODE_PATTERN.test("ABC2345")).toBe(false);
    expect(PAIRING_CODE_PATTERN.test("ABCDL345")).toBe(false);
  });
});
