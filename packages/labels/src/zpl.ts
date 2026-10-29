import { encode, normalizeTagCode, TAG_DIGITS } from "rules";

// 4 x 6 inches at the Zebra default 203 dpi. All field bytes are escaped: customer
// text cannot inject ^XZ, ~JA or a second printer command. TextEncoder (not Buffer) so
// stations can render labels in the browser.
const field = (s: string) =>
  [...new TextEncoder().encode(s)].map((b) => `_${b.toString(16).padStart(2, "0")}`).join("");
const text = (x: number, y: number, s: string, h = 36, w = h) =>
  `^FO${x},${y}^A0N,${h},${w}^FH_^FD${field(s)}^FS`;
const qr = (x: number, y: number, s: string) => `^FO${x},${y}^BQN,2,7^FDLA,${s}^FS`;
const label = (...parts: string[]) => `^XA^CI28^PW812^LL1218\n${parts.join("\n")}\n^XZ`;

export type ToteTag = {
  intakeNumber: string;
  toteNo: number;
  toteCount: number;
  customer: string;
  date: string;
  lines: { species: string; lb: number; shorthand: string }[];
  banners?: ("FAST PASS" | "DIRTY" | "RIBBING" | "SMOKED EXCHANGE")[];
};
export function toteTag(v: ToteTag): string {
  if (v.toteNo > v.toteCount || v.lines.length > 6)
    throw new RangeError("Invalid tote count or too many species lines");
  return label(
    text(20, 20, v.intakeNumber, 282, 88),
    text(24, 320, v.customer.slice(0, 38), 38),
    text(24, 375, `${v.date}    Tote ${v.toteNo} of ${v.toteCount}`),
    ...v.lines.map((l, i) =>
      text(24, 435 + i * 45, `${l.species} ${l.lb} lb ${l.shorthand}`.slice(0, 42)),
    ),
    qr(24, 740, encode("TOTE", v)),
    ...(v.banners ?? []).map((b, i) => text(330, 770 + i * 85, b, 42, 25)),
  );
}
export function storageBoxLabel(v: {
  storageNumber: string;
  boxNo: number;
  customer: string;
  date: string;
}): string {
  return label(
    text(25, 30, v.storageNumber, 100),
    text(25, 180, v.customer.slice(0, 32), 44),
    text(25, 260, `Box ${v.boxNo} · ${v.date}`),
    qr(25, 380, encode("SBOX", v)),
  );
}
/** Pass two existing location master codes; this renderer never generates phantom locations. */
export function locationTag(v: { orgSlug: string; rearCode: string; frontCode: string }): string {
  if (!v.rearCode.endsWith("-R") || v.frontCode !== v.rearCode.slice(0, -1) + "F")
    throw new RangeError("Expected matching rear/front shelf positions");
  return label(
    text(25, 20, `R  ${v.rearCode}`, 62, 38),
    qr(25, 140, encode("LOC", { orgSlug: v.orgSlug, code: v.rearCode })),
    text(25, 620, `F  ${v.frontCode}`, 62, 38),
    qr(25, 750, encode("LOC", { orgSlug: v.orgSlug, code: v.frontCode })),
  );
}
/** One existing location master code: a pallet / quarantine location or an unpaired shelf. */
export function singleLocationTag(v: { orgSlug: string; code: string }): string {
  return label(
    text(25, 20, v.code, 62, 38),
    qr(25, 140, encode("LOC", { orgSlug: v.orgSlug, code: v.code })),
  );
}
/**
 * Tag sheet for existing location master codes, in the order given (walk order). A shelf
 * whose F and R positions are both listed shares one rear-over-front label; every other
 * code prints alone. Never invents a code that was not passed in.
 */
export function locationTagSheet(v: { orgSlug: string; codes: string[] }): string {
  const listed = new Set(v.codes);
  const labels: string[] = [];
  for (const code of v.codes) {
    const base = code.slice(0, -1);
    if (code.endsWith("-R") && listed.has(`${base}F`)) continue;
    labels.push(
      code.endsWith("-F") && listed.has(`${base}R`)
        ? locationTag({ orgSlug: v.orgSlug, rearCode: `${base}R`, frontCode: code })
        : singleLocationTag({ orgSlug: v.orgSlug, code }),
    );
  }
  return labels.join("\n");
}
/** One label per tag at the org's width (`scanner.tag_digits`, default 3). */
export function assetTagSheet(v: { orgSlug: string; codes: string[]; tagDigits?: number }): string {
  const digits = v.tagDigits ?? TAG_DIGITS;
  return v.codes
    .map((raw) => {
      const code = normalizeTagCode(raw, digits);
      if (!code || code.length !== digits) {
        throw new RangeError(`Asset codes must fit ${digits} digits`);
      }
      return label(
        text(25, 25, code, 200),
        `^FO25,280^BCN,120,Y,N,N^FD${code}^FS`,
        qr(25, 520, encode("TAG", { orgSlug: v.orgSlug, code }, { tagDigits: digits })),
      );
    })
    .join("\n");
}
// The domain defines no BOX-plan QR format. Box labels use the settlement boxing
// token, identical to the settlement receipt, rather than inventing a new parser.
export function boxLabel(v: {
  token: string;
  boxNumber: string;
  customer: string;
  contents: string[];
}): string {
  return label(
    text(25, 25, v.boxNumber, 100),
    text(25, 170, v.customer.slice(0, 35), 44),
    ...v.contents.slice(0, 8).map((s, i) => text(25, 250 + i * 48, s.slice(0, 42))),
    qr(25, 720, encode("BOX", v)),
  );
}
