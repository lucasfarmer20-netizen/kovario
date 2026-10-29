import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  encode,
  normalizePairingCode,
  normalizeTagCode,
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  parse,
  parseManual,
  shortCode,
  QR_PREFIX,
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

// Issue #84: typed codes for a dead scanner. Named M1… after the manual-entry invariants.
describe("parseManual / shortCode (typed codes, issue #84)", () => {
  const gridCode = fc
    .tuple(
      fc.stringMatching(/^[A-Z]{1,4}$/).filter((zone) => zone !== "INT" && zone !== "STG"),
      fc.stringMatching(/^[A-Z0-9]{1,4}$/),
      fc.integer({ min: 1, max: 99 }),
      fc.integer({ min: 1, max: 9 }),
      fc.constantFrom("F", "R"),
    )
    .map(([zone, row, bay, level, depth]) =>
      [zone, row, String(bay).padStart(2, "0"), level, depth].join("-"),
    );
  const shortPayloads = {
    TOTE: payloads.TOTE,
    TAG: payloads.TAG,
    LOC: fc.record({ orgSlug, code: gridCode }),
    SBOX: payloads.SBOX,
    PAIR: payloads.PAIR,
  } as const;

  for (const kind of Object.keys(shortPayloads) as (keyof typeof shortPayloads)[]) {
    it(`M1 ${kind}: the printed short code reads back as the label's own QR text`, () => {
      fc.assert(
        fc.property(shortPayloads[kind] as fc.Arbitrary<QrFields[typeof kind]>, (f) => {
          const slug = "orgSlug" in f ? f.orgSlug : undefined;
          const typed = shortCode(kind, f);
          const r = parseManual(typed, { orgSlug: slug, accept: [kind] });
          expect(r).toEqual({ ...parse(encode(kind, f)), text: encode(kind, f) });
        }),
      );
    });
  }

  it("M2 tote: `INT-0001-3`, `INT-0001 3`, lower case and dropped zeros", () => {
    const tote = { kind: "TOTE", intakeNumber: "INT-0001", toteNo: 3, legacy: false };
    for (const typed of [
      "INT-0001-3",
      "INT-0001 3",
      " int-0001-3 ",
      "INT 0001 3",
      "INT-1-3",
      "INT0001-03",
    ])
      expect(parseManual(typed)).toEqual({ ok: true, value: tote, text: "FL:TOTE:INT-0001:3" });
    expect(shortCode("TOTE", { intakeNumber: "INT-0001", toteNo: 3 })).toBe("INT-0001-3");
    // Intake only: the bare legacy form a scan of an old label sends.
    expect(parseManual("int-0042")).toEqual({
      ok: true,
      value: { kind: "TOTE", intakeNumber: "INT-0042", toteNo: null, legacy: true },
      text: "INT-0042",
    });
  });

  it("M3 asset tag: `42` / `042` / `0042`, padded per scanner.tag_digits", () => {
    for (const typed of ["42", "042", "0042", " 42 "])
      expect(parseManual(typed)).toEqual({
        ok: true,
        value: { kind: "TAG", orgSlug: null, code: "042", legacy: true },
        text: "042",
      });
    expect(parseManual("42", { tagDigits: 4, orgSlug: "demo-plant" })).toEqual({
      ok: true,
      value: { kind: "TAG", orgSlug: "demo-plant", code: "0042", legacy: false },
      text: "FL:TAG:demo-plant:0042",
    });
    expect(shortCode("TAG", { orgSlug: "demo", code: "7" }, { tagDigits: 4 })).toBe("0007");
  });

  it("M4 location: `IF-A-01-1-F` in any case, spaces for dashes, pallets", () => {
    const loc = (code: string) => ({
      ok: true,
      value: { kind: "LOC", orgSlug: null, code, legacy: true },
      text: code,
    });
    expect(parseManual("IF-A-01-1-F")).toEqual(loc("IF-A-01-1-F"));
    expect(parseManual("if a 01 1 f")).toEqual(loc("IF-A-01-1-F"));
    expect(parseManual("bf-pallet-03")).toEqual(loc("BF-PALLET-03"));
    expect(parseManual("if-a-01-1-f", { orgSlug: "demo" })).toMatchObject({
      ok: true,
      text: "FL:LOC:demo:IF-A-01-1-F",
    });
    expect(shortCode("LOC", { orgSlug: "demo", code: "IF-A-01-1-F" })).toBe("IF-A-01-1-F");
  });

  it("M5 storage box: `STG-0001-2` and `STG-0001 2`", () => {
    const box = { kind: "SBOX", storageNumber: "STG-0001", boxNo: 2, legacy: false };
    for (const typed of ["STG-0001-2", "STG-0001 2", "stg-1-2"])
      expect(parseManual(typed)).toEqual({ ok: true, value: box, text: "FL:SBOX:STG-0001:2" });
    expect(shortCode("SBOX", { storageNumber: "STG-0001", boxNo: 2 })).toBe("STG-0001-2");
  });

  it("M6 pairing code: typed with a dash or in lower case at /pair", () => {
    const pair = {
      ok: true,
      value: { kind: "PAIR", code: "ABCD2345", legacy: false },
      text: "FL:PAIR:ABCD2345",
    };
    expect(parseManual("abcd2345")).toEqual(pair);
    expect(parseManual("abcd-2345", { accept: ["PAIR"] })).toEqual(pair);
    expect(shortCode("PAIR", { code: "abcd-2345" })).toBe("ABCD2345");
  });

  it("M7 the station's accepted kinds settle a code that reads two ways", () => {
    // All-digit pairing codes are also asset-tag codes; `ABCD-2345` is also location-shaped.
    expect(parseManual("23456789")).toMatchObject({ ok: true, value: { kind: "TAG" } });
    expect(parseManual("23456789", { accept: ["PAIR"] })).toMatchObject({
      ok: true,
      value: { kind: "PAIR", code: "23456789" },
    });
    expect(parseManual("ABCD-2345")).toMatchObject({ ok: true, value: { kind: "LOC" } });
    expect(parseManual("ABCD-2345", { accept: ["PAIR"] })).toMatchObject({
      value: { kind: "PAIR" },
    });
    // No accepted reading: the first reading is still returned, for the server to reject.
    expect(parseManual("042", { accept: ["TOTE"] })).toMatchObject({ value: { kind: "TAG" } });
  });

  it("M8 full QR text is accepted as typed, prefix in any case", () => {
    expect(parseManual("fl:tote:INT-0001:2")).toEqual({
      ok: true,
      value: { kind: "TOTE", intakeNumber: "INT-0001", toteNo: 2, legacy: false },
      text: "FL:TOTE:INT-0001:2",
    });
    expect(parseManual("FL:BOX:abc_123")).toMatchObject({ ok: true, text: "FL:BOX:abc_123" });
  });

  it("M9 rejects malformed codes with the scan parser's reasons", () => {
    expect(parseManual("   ")).toEqual({ ok: false, reason: "empty" });
    for (const typed of [
      "STG-0001",
      "INT-0001-0",
      "STG-0001-x",
      "FL:TOTE:INT-0001",
      "FL:TAG:Bad Slug:042",
    ])
      expect(parseManual(typed), typed).toEqual({ ok: false, reason: "bad_field" });
    for (const typed of ["hello", "INT-", "IF_A_01", "4.2", "-042", "ABC", "FL:", "FL:NOPE:x"])
      expect(parseManual(typed), typed).toEqual({ ok: false, reason: "unknown_format" });
  });

  it("M10 never throws, even with a bad org slug option", () => {
    expect(parseManual("042", { orgSlug: "Not A Slug" })).toMatchObject({ ok: true, text: "042" });
    fc.assert(
      fc.property(fc.string(), (raw) => {
        expect(() => parseManual(raw, { orgSlug: "demo" })).not.toThrow();
      }),
    );
  });

  it("M11 shortCode refuses fields a label could not carry", () => {
    expect(() => shortCode("TOTE", { intakeNumber: "INT-1", toteNo: 1 })).toThrow(RangeError);
    expect(() => shortCode("TAG", { orgSlug: "demo", code: "4a" })).toThrow(RangeError);
    expect(() => shortCode("SBOX", { storageNumber: "STG-0001", boxNo: 0 })).toThrow(RangeError);
  });
});
