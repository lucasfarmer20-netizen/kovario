export * from "./zpl";
import { encode, parseStatusPageUrl, statusPageUrl } from "rules";
import QRCode from "qrcode";
import { chromium } from "playwright";
const html = (v: string | number) =>
  String(v).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
export type Receipt = {
  kind: "intake" | "pickup" | "settlement" | "storage";
  number: string;
  customer: string;
  date: string;
  lines: { description: string; quantity: number; rate: number; amount: number }[];
  total: number;
  notice?: string;
  estimatedPickup?: string;
  statusUrl?: string;
  orgSlug?: string;
  boxingToken?: string;
  storage?: { storageNumber: string; boxNo: number };
  // Snapshot from the stored payment row, never terminal/live lookup on reprint.
  payment?: { brand: string; last4: string; entry: string; auth: string };
};
const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
async function qrImage(payload: string): Promise<string> {
  return `<figure data-qr="${html(payload)}"><img width="180" height="180" alt="Scan code" src="${await QRCode.toDataURL(payload)}"/></figure>`;
}
function document(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${html(title)}</title><style>@page{size:Letter;margin:15mm}body{font:16px Arial;color:#111}h1{font-size:28px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #bbb}figure{break-inside:avoid}img{image-rendering:pixelated}</style></head><body>${body}</body></html>`;
}
export async function receiptHtml(v: Receipt): Promise<string> {
  const statusUrl = v.orgSlug ? statusPageUrl(v.orgSlug) : v.statusUrl;
  if (v.kind === "settlement" && !v.boxingToken)
    throw new RangeError("Settlement needs a boxing token");
  if (v.kind === "intake" && !statusUrl) throw new RangeError("Intake needs a status URL");
  if (v.payment && !/^\d{4}$/.test(v.payment.last4))
    throw new RangeError("Payment snapshot needs last4 only");
  if (statusUrl && !parseStatusPageUrl(statusUrl))
    throw new RangeError("Invalid public status URL");
  const code = v.boxingToken
    ? encode("BOX", { token: v.boxingToken })
    : v.storage
      ? encode("SBOX", v.storage)
      : statusUrl;
  return document(
    `${v.kind} receipt ${v.number}`,
    `<h1>${html(v.kind)} receipt · ${html(v.number)}</h1><p>${html(v.customer)} · ${html(v.date)}</p>
    <table><thead><tr><th>Description</th><th>Quantity</th><th>Rate</th><th>Amount</th></tr></thead><tbody>${v.lines.map((l) => `<tr><td>${html(l.description)}</td><td>${html(l.quantity)}</td><td>${money(l.rate)}</td><td>${money(l.amount)}</td></tr>`).join("")}</tbody></table><h2>Total ${money(v.total)}</h2>
    ${v.estimatedPickup ? `<p>Estimated pickup: ${html(v.estimatedPickup)}</p>` : ""}
    <p>${html(v.notice ?? "Rates shown at intake apply. Final weight and selected services determine the final charge.")}</p>
    ${v.payment ? `<p>${html(v.payment.brand)} ending ${html(v.payment.last4)} · ${html(v.payment.entry)} · Auth ${html(v.payment.auth)}</p>` : ""}${code ? await qrImage(code) : ""}`,
  );
}
export async function pickListHtml(v: {
  number: string;
  token: string;
  customer: string;
  lines: { location: string; description: string; quantity: number }[];
}): Promise<string> {
  return document(
    `Pick list ${v.number}`,
    `<h1>Pick list ${html(v.number)}</h1><p>${html(v.customer)}</p><table><tr><th>Location</th><th>Contents</th><th>Quantity</th></tr>${v.lines.map((l) => `<tr><td>${html(l.location)}</td><td>${html(l.description)}</td><td>${html(l.quantity)}</td></tr>`).join("")}</table>${await qrImage(encode("BOX", v))}`,
  );
}
/** Server-only HTML -> PDF. No untrusted network resources may be fetched by templates. */
export async function htmlToPdf(content: string): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) => route.abort());
    await page.setContent(content, { waitUntil: "load" });
    return await page.pdf({ format: "Letter", printBackground: true });
  } finally {
    await browser.close();
  }
}
export const receiptPdf = async (v: Receipt) => htmlToPdf(await receiptHtml(v));
export const pickListPdf = async (v: Parameters<typeof pickListHtml>[0]) =>
  htmlToPdf(await pickListHtml(v));
