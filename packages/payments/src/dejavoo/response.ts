// Reading a SPIn REST v2 answer (docs/05-PAYMENTS.md §4): GeneralResponse codes, the approved
// amount, the transaction number and the card meta. Card meta merges `ExtData` (a `k=v,k=v`
// string or an object), `ExtendedDataByApplication.<brand>` and `CardData` (most specific
// wins); keys are matched case-insensitively. Only the fields CardMeta names are kept — never
// a PAN.
import type { CardMeta, EntryMode } from "../provider.ts";
import { normalizeStatusCode } from "./codes.ts";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function str(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Case-insensitive lookup of the first present key. */
function pick(o: Obj, ...keys: string[]): unknown {
  const lower = new Map(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
  for (const k of keys) {
    const v = lower.get(k.toLowerCase());
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

export interface SpinGeneral {
  statusCode?: string;
  resultCode?: string;
  message?: string;
  detailedMessage?: string;
  /** trimmed; absent when the host never answered */
  hostResponseCode?: string;
  hostResponseMessage?: string;
}

export function generalResponse(body: Obj): SpinGeneral {
  const g = isObj(body.GeneralResponse) ? body.GeneralResponse : body;
  return {
    statusCode: normalizeStatusCode(pick(g, "StatusCode")),
    resultCode: str(pick(g, "ResultCode")),
    message: str(pick(g, "Message")),
    detailedMessage: str(pick(g, "DetailedMessage")),
    hostResponseCode: str(pick(g, "HostResponseCode")),
    hostResponseMessage: str(pick(g, "HostResponseMessage")),
  };
}

function money(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined;
}

/** The amount the host approved (partial approvals report less than requested). */
export function approvedAmount(body: Obj): number | undefined {
  const amounts = pick(body, "Amounts");
  if (isObj(amounts)) {
    const a = money(pick(amounts, "Amount", "TotalAmount", "ApprovedAmount"));
    if (a !== undefined) return a;
  }
  return money(pick(body, "ApprovedAmount", "Amount"));
}

export function transNum(body: Obj): string | undefined {
  return str(pick(body, "TransNum", "TransactionNumber", "TransactionNum"));
}

/** What Dejavoo did with a Void: `Void` (pre-batch) or `Return` (refunded after the batch). */
export function processedAs(body: Obj): string | undefined {
  return str(pick(body, "ProcessedAs"));
}

/** `k=v,k=v` (values may contain `=`) or an object → object. */
export function parseExtData(v: unknown): Obj {
  if (isObj(v)) return v;
  if (typeof v !== "string") return {};
  const out: Obj = {};
  for (const part of v.split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function byApplication(body: Obj, brand: string | undefined): Obj {
  const apps = pick(body, "ExtendedDataByApplication");
  if (!isObj(apps)) return {};
  const entries = Object.entries(apps).filter(([, v]) => isObj(v)) as [string, Obj][];
  const match = brand && entries.find(([k]) => k.toLowerCase() === brand.toLowerCase());
  return match ? match[1] : entries.length === 1 ? entries[0]![1] : {};
}

function entryMode(v: unknown): EntryMode | undefined {
  const s = str(v)
    ?.toLowerCase()
    .replace(/[^a-z]/g, "");
  if (!s) return undefined;
  if (/contactless|ctls|tap|nfc|proximity|wave/.test(s)) return "contactless";
  if (/chip|emv|icc|dip|insert/.test(s)) return "chip";
  if (/swipe|msr|magstripe|stripe|fallback/.test(s)) return "swipe";
  if (/manual|keyed|key/.test(s)) return "keyed";
  return undefined;
}

function last4(v: unknown): string | undefined {
  const digits = str(v)?.replace(/\D/g, "");
  return digits && digits.length >= 4 ? digits.slice(-4) : undefined;
}

export function cardMeta(body: Obj): CardMeta {
  const cardData = isObj(pick(body, "CardData")) ? (pick(body, "CardData") as Obj) : {};
  const ext = parseExtData(pick(body, "ExtData"));
  const brandHint = str(pick(cardData, "CardType", "CardBrand", "Brand"));
  const merged: Obj = { ...ext, ...byApplication(body, brandHint), ...cardData };
  const g = generalResponse(body);
  const meta: CardMeta = {
    brand: str(pick(merged, "CardType", "CardBrand", "Brand", "AppLabel", "ApplicationLabel")),
    last4: last4(pick(merged, "Last4", "AcntLast4", "AcntLast")),
    entryMode: entryMode(pick(merged, "EntryType", "EntryMode", "EntryMethod", "PosEntryMode")),
    authCode: str(pick(body, "AuthCode")) ?? str(pick(merged, "AuthCode")),
    hostResponseCode: g.hostResponseCode,
    token: str(pick(merged, "IPosToken", "Token")) ?? str(pick(body, "IPosToken", "Token")),
  };
  return Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)) as CardMeta;
}
