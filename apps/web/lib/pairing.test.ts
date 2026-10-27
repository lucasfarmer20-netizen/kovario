import { describe, expect, it } from "vitest";
import { pairingQrText, readPairingInput } from "./pairing";

describe("pairing QR", () => {
  it("is produced by the rules QR codec", () => {
    expect(pairingQrText("ABCD2345")).toBe("KV:PAIR:ABCD2345");
    expect(() => pairingQrText("ABCD0OIL")).toThrow(RangeError);
  });

  it("round-trips through what /pair reads from a scan", () => {
    for (const code of ["ABCD2345", "23456789", "ZZZZZZZZ"]) {
      expect(readPairingInput(pairingQrText(code))).toBe(code);
      // Keyboard-wedge scanners append CR/LF.
      expect(readPairingInput(`${pairingQrText(code)}\r\n`)).toBe(code);
    }
  });

  it("accepts a typed code, including all-digit codes", () => {
    expect(readPairingInput(" abcd-2345 ")).toBe("ABCD2345");
    expect(readPairingInput("23456789")).toBe("23456789");
  });

  it("rejects other QR kinds and invalid codes", () => {
    expect(readPairingInput("KV:TOTE:INT-0001:1")).toBeNull();
    expect(readPairingInput("KV:TAG:demo-plant:042")).toBeNull();
    expect(readPairingInput("KV:PAIR:ABCDL345")).toBeNull();
    expect(readPairingInput("ABCD0OIL")).toBeNull();
    expect(readPairingInput("")).toBeNull();
  });
});
