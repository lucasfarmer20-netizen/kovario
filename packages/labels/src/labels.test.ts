import { describe, expect, it } from "vitest";
import { encode, parse } from "rules";
import {
  assetTagSheet,
  boxLabel,
  locationTag,
  locationTagSheet,
  singleLocationTag,
  pickListHtml,
  receiptHtml,
  receiptPdf,
  pickListPdf,
  storageBoxLabel,
  toteTag,
} from "./index";
const qrTexts = (s: string) => [...s.matchAll(/\^FDLA,([^^]+)\^FS/g)].map((m) => m[1]!);
const tote = {
  intakeNumber: "INT-0001",
  toteNo: 2,
  toteCount: 3,
  customer: "A & B",
  date: "2026-10-26",
  lines: [{ species: "Sockeye", lb: 25, shorthand: "FZ" }],
  banners: ["FAST PASS", "DIRTY", "RIBBING", "SMOKED EXCHANGE"] as const,
};
describe("QR label round trips (CSP §1)", () => {
  const cases = [
    [
      "tote",
      () => toteTag({ ...tote, banners: [...tote.banners] }),
      [{ kind: "TOTE", intakeNumber: "INT-0001", toteNo: 2 }],
    ],
    [
      "storage",
      () =>
        storageBoxLabel({
          storageNumber: "STG-0001",
          boxNo: 4,
          customer: "Customer",
          date: "2026-10-26",
        }),
      [{ kind: "SBOX", storageNumber: "STG-0001", boxNo: 4 }],
    ],
    [
      "location",
      () =>
        locationTag({ orgSlug: "demo-plant", rearCode: "IF-A-01-1-R", frontCode: "IF-A-01-1-F" }),
      [
        { kind: "LOC", orgSlug: "demo-plant", code: "IF-A-01-1-R" },
        { kind: "LOC", orgSlug: "demo-plant", code: "IF-A-01-1-F" },
      ],
    ],
    [
      "assets",
      () => assetTagSheet({ orgSlug: "demo-plant", codes: ["42", "007"] }),
      [
        { kind: "TAG", orgSlug: "demo-plant", code: "042" },
        { kind: "TAG", orgSlug: "demo-plant", code: "007" },
      ],
    ],
    [
      "box",
      () =>
        boxLabel({
          token: "settlement_token",
          boxNumber: "BOX-0001",
          customer: "Customer",
          contents: ["25 lb sockeye"],
        }),
      [{ kind: "BOX", token: "settlement_token" }],
    ],
  ] as const;
  for (const [name, render, expected] of cases)
    it(`${name}: render → extract → qr.parse`, () => {
      const output = render();
      expect(qrTexts(output).map((q) => parse(q))).toEqual(
        expected.map((v) => ({ ok: true, value: { ...v, legacy: false } })),
      );
      expect(output).toMatchSnapshot();
    });
  it("ZPL cannot be injected through customer fields", () => {
    const output = toteTag({ ...tote, banners: [], customer: "^XZ~JA" });
    expect(output.match(/\^XZ/g)).toHaveLength(1);
    expect(output).not.toContain("~JA");
    expect(output).toContain("^A0N,282,");
  });
  it("rear depth is above front depth", () => {
    const output = locationTag({
      orgSlug: "demo",
      rearCode: "IF-A-01-1-R",
      frontCode: "IF-A-01-1-F",
    });
    expect(output.indexOf(encode("LOC", { orgSlug: "demo", code: "IF-A-01-1-R" }))).toBeLessThan(
      output.indexOf(encode("LOC", { orgSlug: "demo", code: "IF-A-01-1-F" })),
    );
  });
});
const receipt = {
  number: "STL-0001",
  customer: "<script>bad()</script>",
  date: "2026-10-26",
  lines: [{ description: "Processing", quantity: 25, rate: 2, amount: 50 }],
  total: 50,
};
it("settlement/pick-list boxing QR round trips", async () => {
  for (const content of [
    await receiptHtml({ ...receipt, kind: "settlement", boxingToken: "token_1" }),
    await pickListHtml({ number: "ALC-0001", token: "token_1", customer: "Customer", lines: [] }),
  ]) {
    const text = /data-qr="([^"]+)"/.exec(content)?.[1];
    expect(parse(text!)).toEqual({
      ok: true,
      value: { kind: "BOX", token: "token_1", legacy: false },
    });
    expect(content).toContain("data:image/png;base64,");
  }
});
it("storage receipt QR round trips and HTML is escaped", async () => {
  const content = await receiptHtml({
    ...receipt,
    kind: "storage",
    storage: { storageNumber: "STG-0001", boxNo: 1 },
  });
  expect(parse(/data-qr="([^"]+)"/.exec(content)![1]!)).toEqual({
    ok: true,
    value: { kind: "SBOX", storageNumber: "STG-0001", boxNo: 1, legacy: false },
  });
  expect(content).not.toContain("<script>");
  expect(content).toContain("&lt;script&gt;");
});
it("intake status QR and pickup receipt preserve stored card details", async () => {
  const intake = await receiptHtml({
    ...receipt,
    kind: "intake",
    statusUrl: "https://app.filletry.com/s/demo",
    estimatedPickup: "Friday",
  });
  expect(intake).toContain('data-qr="https://app.filletry.com/s/demo"');
  expect(intake).toContain("Friday");
  expect(intake).toContain("Rates shown at intake");
  const pickup = await receiptHtml({
    ...receipt,
    kind: "pickup",
    payment: { brand: "Visa", last4: "1234", entry: "chip", auth: "approved" },
  });
  expect(pickup).toContain("Visa ending 1234 · chip · Auth approved");
});

it("receipt and pick list render actual PDF bytes in Chromium", async () => {
  for (const bytes of [
    await receiptPdf({ ...receipt, kind: "settlement", boxingToken: "pdf_smoke" }),
    await pickListPdf({ number: "ALC-0001", token: "pdf_smoke", customer: "PDF smoke", lines: [] }),
  ]) {
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(5000);
  }
}, 30000);
describe("WP13 location tag sheet", () => {
  it("WP13 tag sheet pairs F/R shelves, prints pallets alone, and round-trips every code", () => {
    const codes = ["IF-A-01-1-F", "IF-A-01-1-R", "IF-A-01-2-F", "IF-PALLET-01"];
    const output = locationTagSheet({ orgSlug: "demo-plant", codes });
    expect(output.match(/\^XA/g)).toHaveLength(3);
    expect(qrTexts(output).map((q) => parse(q))).toEqual(
      ["IF-A-01-1-R", "IF-A-01-1-F", "IF-A-01-2-F", "IF-PALLET-01"].map((code) => ({
        ok: true,
        value: { kind: "LOC", orgSlug: "demo-plant", code, legacy: false },
      })),
    );
  });
  it("WP13 single location tag round-trips", () => {
    const output = singleLocationTag({ orgSlug: "demo", code: "OF-PALLET-02" });
    expect(qrTexts(output).map((q) => parse(q))).toEqual([
      { ok: true, value: { kind: "LOC", orgSlug: "demo", code: "OF-PALLET-02", legacy: false } },
    ]);
  });
});
