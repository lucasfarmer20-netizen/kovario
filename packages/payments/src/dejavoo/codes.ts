// SPIn REST v2 StatusCode classification (docs/05-PAYMENTS.md §4, verbatim). Classify on the
// 4-digit `GeneralResponse.StatusCode`, never on `ResultCode`.

export const SPIN_STATUS_CLASSES = [
  "approved",
  "cancelled",
  "declined",
  "indeterminate",
  "bad_request",
  "config_error",
  "lookup_error",
] as const;
export type SpinStatusClass = (typeof SPIN_STATUS_CLASSES)[number];

export const SPIN_STATUS_CODES: Readonly<Record<SpinStatusClass, readonly string[]>> = {
  // 0001 = partial approval, 1500 = signature not captured
  approved: ["0000", "0001", "1500"],
  cancelled: ["1012"],
  declined: ["1015"],
  // → run Status
  indeterminate: [
    "1000",
    "1005",
    "1006",
    "1030",
    "1999",
    "2001",
    "2007",
    "2008",
    "2010",
    "2011",
    "2110",
  ],
  // a request we built wrong (dev fix)
  bad_request: ["1002", "1003", "1004", "1007", "1008", "1013", "1016", "2006", "2102", "2201"],
  // terminal / account setup (reach the processor)
  config_error: ["1009", "1017", "1019", "1020", "1024", "2002", "2003", "2004", "2005", "2101"],
  lookup_error: ["1001", "1010", "1011", "2009", "2301"],
};

const BY_CODE = new Map<string, SpinStatusClass>(
  SPIN_STATUS_CLASSES.flatMap((c) => SPIN_STATUS_CODES[c].map((code) => [code, c] as const)),
);

/** The 4-digit form of a StatusCode the proxy may send as a number (`0` → `"0000"`). */
export function normalizeStatusCode(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return String(v).padStart(4, "0");
  if (typeof v === "string" && /^\d{1,4}$/.test(v.trim())) return v.trim().padStart(4, "0");
  return undefined;
}

/** A code outside the table is `unknown` — treated like indeterminate (never assume). */
export function classifyStatusCode(code: string | undefined): SpinStatusClass | "unknown" {
  return (code && BY_CODE.get(code)) || "unknown";
}
