import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  encode,
  MAX_TAG_DIGITS,
  maxTagNumber,
  NEW_ORG_TAG_DIGITS,
  normalizePairingCode,
  normalizeTagCode,
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  parse,
  QR_PREFIX,
  sameTagCode,
  TAG_DIGITS,
  type QrFields,
  type QrKind,
} from "./qr.ts";

const intakeNumber = fc.nat({ max: 99_999_999 }).map((n) => `INT-${String(n).padStart(4, "0")}`);
const storageNumber = fc.nat({ max: 99_999_999 }).map((n) => `STG-${String(n).padStart(4, "0")}`);
const count = fc.integer({ min: 1, max: 100_000 });
const orgSlug = fc.stringMatching(/^[a-z0-9]{1,12}(?:-[a-z0-9]{1,12}){0,3}$/);
const tagCode = fc.nat({ max: 99_999 }).map((n) => String(n).padStart(3, "0"));
const locationCode = fc.stringMatching(/^[A-Z0-9]{1,8}(?:-[A-Z0-9]{1,8}){0,5}$/);
const token = fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/);
const pairingCode = fc
  .array(fc.constantFrom(...PAIRING_ALPHABET), {
    minLength: PAIRING_CODE_LENGTH,
    maxLength: PAIRING_CODE_LENGTH,
  })
  .map((chars) => chars.join(""));

const payloads: { [K in QrKind]: fc.Arbitrary<QrFields[K]> } = {
  TOTE: fc.record({ intakeNumber, toteNo: count }),
  TAG: fc.record({ orgSlug, code: tagCode }),
  LOC: fc.record({ orgSlug, code: locationCode }),
  BOX: fc.record({ token }),
  SBOX: fc.record({ storageNumber, boxNo: count }),
  PAIR: fc.record({ code: pairingCode }),
};

describe("qr round-trip (property)", () => {
  for (const kind of Object.keys(payloads) as QrKind[]) {
    it(`parse(encode(${kind}, f)) === f`, () => {
      fc.assert(
        fc.property(payloads[kind] as fc.Arbitrary<QrFields[QrKind]>, (fields) => {
          const text = encode(kind, fields as never);
          expect(parse(text)).toEqual({ ok: true, value: { kind, ...fields, legacy: false } });
          // Scanners append CR/LF; whitespace never changes the result.
          expect(parse(`  ${text}\r\n`)).toEqual(parse(text));
        }),
      );
    });
  }

  it("parse never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const result = parse(raw);
        expect(typeof result.ok).toBe("boolean");
      }),
    );
  });

  it("asset tags round-trip through any padding", () => {
    fc.assert(
      fc.property(orgSlug, fc.nat({ max: 999 }), fc.nat({ max: 3 }), (slug, n, pad) => {
        const padded = "0".repeat(pad) + String(n);
        const canonical = String(n).padStart(3, "0");
        expect(encode("TAG", { orgSlug: slug, code: padded })).toBe(`FL:TAG:${slug}:${canonical}`);
        expect(parse(`FL:TAG:${slug}:${padded}`)).toEqual({
          ok: true,
          value: { kind: "TAG", orgSlug: slug, code: canonical, legacy: false },
        });
      }),
    );
  });
});

describe("encode", () => {
  it("prefixes every payload with FL (Filletry, DECISION-16)", () => {
    expect(QR_PREFIX).toBe("FL");
  });

  it("produces the documented formats", () => {
    expect(encode("TOTE", { intakeNumber: "INT-0001", toteNo: 3 })).toBe("FL:TOTE:INT-0001:3");
    expect(encode("TAG", { orgSlug: "demo-plant", code: "42" })).toBe("FL:TAG:demo-plant:042");
    expect(encode("LOC", { orgSlug: "demo-plant", code: "IF-A-01-1-F" })).toBe(
      "FL:LOC:demo-plant:IF-A-01-1-F",
    );
    expect(encode("LOC", { orgSlug: "demo-plant", code: "IF-PALLET-01" })).toBe(
      "FL:LOC:demo-plant:IF-PALLET-01",
    );
    expect(encode("BOX", { token: "aB3_x-9" })).toBe("FL:BOX:aB3_x-9");
    expect(encode("SBOX", { storageNumber: "STG-0001", boxNo: 2 })).toBe("FL:SBOX:STG-0001:2");
    expect(encode("PAIR", { code: "ABCD2345" })).toBe("FL:PAIR:ABCD2345");
  });

  it("canonicalises a typed pairing code on encode", () => {
    expect(encode("PAIR", { code: "abcd-2345" })).toBe("FL:PAIR:ABCD2345");
  });

  it("refuses fields that would not parse back", () => {
    expect(() => encode("TOTE", { intakeNumber: "INT-1", toteNo: 1 })).toThrow(RangeError);
    expect(() => encode("TOTE", { intakeNumber: "INT-0001", toteNo: 0 })).toThrow(RangeError);
    expect(() => encode("TOTE", { intakeNumber: "INT-0001", toteNo: 1.5 })).toThrow(RangeError);
    expect(() => encode("TAG", { orgSlug: "Demo", code: "042" })).toThrow(RangeError);
    expect(() => encode("TAG", { orgSlug: "demo", code: "4a" })).toThrow(RangeError);
    expect(() => encode("LOC", { orgSlug: "demo", code: "IF:A" })).toThrow(RangeError);
    expect(() => encode("BOX", { token: "a:b" })).toThrow(RangeError);
    expect(() => encode("SBOX", { storageNumber: "INT-0001", boxNo: 1 })).toThrow(RangeError);
    expect(() => encode("PAIR", { code: "ABCD0OIL" })).toThrow(RangeError);
    expect(() => encode("PAIR", { code: "ABC2345" })).toThrow(RangeError);
    expect(() => encode("PAIR", { code: "ABCD:345" })).toThrow(RangeError);
  });
});

describe("parse", () => {
  it("bare legacy intake number → a tote of that intake", () => {
    expect(parse("INT-0001")).toEqual({
      ok: true,
      value: { kind: "TOTE", intakeNumber: "INT-0001", toteNo: null, legacy: true },
    });
  });

  it("bare legacy tag code → normalised asset tag", () => {
    for (const raw of ["42", "042", "0042", " 42\n"]) {
      expect(parse(raw)).toEqual({
        ok: true,
        value: { kind: "TAG", orgSlug: null, code: "042", legacy: true },
      });
    }
  });

  it("rejects empty input", () => {
    expect(parse("")).toEqual({ ok: false, reason: "empty" });
    expect(parse(" \r\n")).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects unknown formats", () => {
    for (const raw of [
      "hello",
      "FL:NOPE:x",
      "XX:TOTE:INT-0001:1",
      "IF-A-01-1-F",
      "fl:tote:INT-0001:1",
      "fl:pair:ABCD2345",
      // The pre-rename Kovario prefix was never printed; it is not accepted. Joined so the
      // literal old prefix appears nowhere outside qr.ts history (issue #45).
      ["KV", "TOTE", "INT-0001", "1"].join(":"),
      ["KV", "PAIR", "ABCD2345"].join(":"),
      // A bare 8-character code is not a station scan; only /pair accepts it typed.
      "ABCD2345",
    ]) {
      expect(parse(raw)).toEqual({ ok: false, reason: "unknown_format" });
    }
  });

  it("rejects known kinds with bad or missing fields", () => {
    for (const raw of [
      "FL:TOTE:INT-0001",
      "FL:TOTE:INT-0001:0",
      "FL:TOTE:INT-0001:01",
      "FL:TOTE:INT-0001:1:2",
      "FL:TOTE:INT-1:1",
      "FL:TOTE:INT-0001:99999999999999999999",
      "FL:TAG:demo:4a",
      "FL:TAG::042",
      "FL:LOC:demo:if-a",
      "FL:BOX:",
      "FL:BOX:a b",
      "FL:SBOX:STG-0001:x",
      "FL:SBOX:STG-01:1",
      "FL:TOTE",
      "FL:PAIR:",
      "FL:PAIR:ABCDL345",
      "FL:PAIR:ABCD-2345",
      "FL:PAIR:ABCD23456",
      "FL:PAIR:ABCD2345:1",
    ]) {
      expect(parse(raw), raw).toEqual({ ok: false, reason: "bad_field" });
    }
  });
});

describe("PAIR", () => {
  it("parses a scanned pairing payload, normalising letter case", () => {
    expect(parse("FL:PAIR:abcd2345\r\n")).toEqual({
      ok: true,
      value: { kind: "PAIR", code: "ABCD2345", legacy: false },
    });
  });

  it("all-digit pairing codes stay pairing codes when encoded", () => {
    // A bare "23456789" would parse as a legacy asset tag; the FL:PAIR wrapper prevents that.
    expect(parse(encode("PAIR", { code: "23456789" }))).toEqual({
      ok: true,
      value: { kind: "PAIR", code: "23456789", legacy: false },
    });
  });
});

describe("normalizePairingCode", () => {
  it("strips spaces and dashes and upper-cases", () => {
    expect(normalizePairingCode(" abcd-2345 ")).toBe("ABCD2345");
  });

  it("accepts exactly the pairing alphabet and length", () => {
    fc.assert(
      fc.property(pairingCode, (code) => {
        expect(normalizePairingCode(code)).toBe(code);
      }),
    );
    for (const bad of ["ABCD0345", "ABCDO345", "ABCD1345", "ABCDI345", "ABCDL345", "ABCDU345"]) {
      expect(normalizePairingCode(bad), bad).toBeNull();
    }
    expect(normalizePairingCode("ABC2345")).toBeNull();
    expect(normalizePairingCode("ABCD23456")).toBeNull();
    expect(normalizePairingCode("FL:PAIR:ABCD2345")).toBeNull();
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const once = normalizePairingCode(raw);
        expect(once === null ? null : normalizePairingCode(once)).toBe(once);
      }),
    );
  });
});

describe("normalizeTagCode", () => {
  it("normalizeTagCode('42') === '042'", () => {
    expect(normalizeTagCode("42")).toBe("042");
  });

  it("canonicalises padding", () => {
    expect(normalizeTagCode("042")).toBe("042");
    expect(normalizeTagCode("0042")).toBe("042");
    expect(normalizeTagCode("0")).toBe("000");
    expect(normalizeTagCode("000")).toBe("000");
    expect(normalizeTagCode("1234")).toBe("1234");
    expect(normalizeTagCode("7", 4)).toBe("0007");
  });

  it("rejects non-digits", () => {
    for (const raw of ["", "4a", "-42", "4.2", "FL:TAG:x:042"])
      expect(normalizeTagCode(raw)).toBeNull();
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^\d{1,8}$/), (raw) => {
        const once = normalizeTagCode(raw);
        expect(once).not.toBeNull();
        expect(normalizeTagCode(once!)).toBe(once);
        expect(Number(once)).toBe(Number(raw));
      }),
    );
  });
});

describe("tagDigits option (org.settings.scanner.tag_digits)", () => {
  it("pads asset tags to the org's width on encode and parse", () => {
    const opts = { tagDigits: 4 };
    expect(encode("TAG", { orgSlug: "demo", code: "42" }, opts)).toBe("FL:TAG:demo:0042");
    expect(parse("FL:TAG:demo:042", opts)).toEqual({
      ok: true,
      value: { kind: "TAG", orgSlug: "demo", code: "0042", legacy: false },
    });
    expect(parse("42", opts)).toEqual({
      ok: true,
      value: { kind: "TAG", orgSlug: null, code: "0042", legacy: true },
    });
  });
});

describe("v1.1 tag capacity (#85)", () => {
  it("new orgs start at 4 digits; the range form's max follows the width", () => {
    expect(NEW_ORG_TAG_DIGITS).toBe(4);
    expect(maxTagNumber(TAG_DIGITS)).toBe(999);
    expect(maxTagNumber(NEW_ORG_TAG_DIGITS)).toBe(9999);
    expect(maxTagNumber(MAX_TAG_DIGITS)).toBe(999_999);
  });

  it("an old 3-digit label resolves to the re-padded code after a raise", () => {
    expect(parse("FL:TAG:demo:042", { tagDigits: 4 })).toMatchObject({
      ok: true,
      value: { kind: "TAG", code: "0042" },
    });
    expect(normalizeTagCode("042", 5)).toBe("00042");
  });

  it("sameTagCode matches a tag at any padding and nothing else", () => {
    fc.assert(
      fc.property(fc.nat({ max: 999_999 }), fc.nat({ max: 3 }), fc.nat({ max: 3 }), (n, a, b) => {
        const x = String(n).padStart(a + 3, "0");
        const y = String(n).padStart(b + 3, "0");
        expect(sameTagCode(x, y)).toBe(true);
        expect(sameTagCode(x, String(n + 1))).toBe(false);
      }),
    );
    expect(sameTagCode("FL:TAG:demo:042", "042")).toBe(false);
    expect(sameTagCode("", "")).toBe(false);
  });
});
