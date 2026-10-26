import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { encode, normalizeTagCode, parse, type QrFields, type QrKind } from "./qr.ts";

const intakeNumber = fc.nat({ max: 99_999_999 }).map((n) => `INT-${String(n).padStart(4, "0")}`);
const storageNumber = fc.nat({ max: 99_999_999 }).map((n) => `STG-${String(n).padStart(4, "0")}`);
const count = fc.integer({ min: 1, max: 100_000 });
const orgSlug = fc.stringMatching(/^[a-z0-9]{1,12}(?:-[a-z0-9]{1,12}){0,3}$/);
const tagCode = fc.nat({ max: 99_999 }).map((n) => String(n).padStart(3, "0"));
const locationCode = fc.stringMatching(/^[A-Z0-9]{1,8}(?:-[A-Z0-9]{1,8}){0,5}$/);
const token = fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/);

const payloads: { [K in QrKind]: fc.Arbitrary<QrFields[K]> } = {
  TOTE: fc.record({ intakeNumber, toteNo: count }),
  TAG: fc.record({ orgSlug, code: tagCode }),
  LOC: fc.record({ orgSlug, code: locationCode }),
  BOX: fc.record({ token }),
  SBOX: fc.record({ storageNumber, boxNo: count }),
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
        expect(encode("TAG", { orgSlug: slug, code: padded })).toBe(`KV:TAG:${slug}:${canonical}`);
        expect(parse(`KV:TAG:${slug}:${padded}`)).toEqual({
          ok: true,
          value: { kind: "TAG", orgSlug: slug, code: canonical, legacy: false },
        });
      }),
    );
  });
});

describe("encode", () => {
  it("produces the documented formats", () => {
    expect(encode("TOTE", { intakeNumber: "INT-0001", toteNo: 3 })).toBe("KV:TOTE:INT-0001:3");
    expect(encode("TAG", { orgSlug: "demo-plant", code: "42" })).toBe("KV:TAG:demo-plant:042");
    expect(encode("LOC", { orgSlug: "demo-plant", code: "IF-A-01-1-F" })).toBe(
      "KV:LOC:demo-plant:IF-A-01-1-F",
    );
    expect(encode("LOC", { orgSlug: "demo-plant", code: "IF-PALLET-01" })).toBe(
      "KV:LOC:demo-plant:IF-PALLET-01",
    );
    expect(encode("BOX", { token: "aB3_x-9" })).toBe("KV:BOX:aB3_x-9");
    expect(encode("SBOX", { storageNumber: "STG-0001", boxNo: 2 })).toBe("KV:SBOX:STG-0001:2");
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
      "KV:NOPE:x",
      "XX:TOTE:INT-0001:1",
      "IF-A-01-1-F",
      "kv:tote:INT-0001:1",
    ]) {
      expect(parse(raw)).toEqual({ ok: false, reason: "unknown_format" });
    }
  });

  it("rejects known kinds with bad or missing fields", () => {
    for (const raw of [
      "KV:TOTE:INT-0001",
      "KV:TOTE:INT-0001:0",
      "KV:TOTE:INT-0001:01",
      "KV:TOTE:INT-0001:1:2",
      "KV:TOTE:INT-1:1",
      "KV:TOTE:INT-0001:99999999999999999999",
      "KV:TAG:demo:4a",
      "KV:TAG::042",
      "KV:LOC:demo:if-a",
      "KV:BOX:",
      "KV:BOX:a b",
      "KV:SBOX:STG-0001:x",
      "KV:SBOX:STG-01:1",
      "KV:TOTE",
    ]) {
      expect(parse(raw), raw).toEqual({ ok: false, reason: "bad_field" });
    }
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
    for (const raw of ["", "4a", "-42", "4.2", "KV:TAG:x:042"])
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
    expect(encode("TAG", { orgSlug: "demo", code: "42" }, opts)).toBe("KV:TAG:demo:0042");
    expect(parse("KV:TAG:demo:042", opts)).toEqual({
      ok: true,
      value: { kind: "TAG", orgSlug: "demo", code: "0042", legacy: false },
    });
    expect(parse("42", opts)).toEqual({
      ok: true,
      value: { kind: "TAG", orgSlug: null, code: "0042", legacy: true },
    });
  });
});
