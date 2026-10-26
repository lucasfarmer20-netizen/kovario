// Processing-method reference data (docs/02-DOMAIN-MODEL.md §3 `processing_method`).
import { SEED } from "./seed.ts";

export const METHOD_CODES = [
  "fresh",
  "portions",
  "fillets",
  "smoking",
  "smoked_exchange_traditional",
  "smoked_exchange_cajun",
  "freeze",
  "head_off",
  "as_is",
] as const;
export type MethodCode = (typeof METHOD_CODES)[number];

/** `fresh` is virtual: it never becomes a charge, it splits into fillets + portions. */
export type ServiceMethodCode = Exclude<MethodCode, "fresh">;

export type MethodKind = "service" | "virtual";

export interface Method {
  code: MethodCode;
  name: string;
  /** Label shorthand from the seed; `null` for the virtual `fresh`. */
  shorthand: string | null;
  kind: MethodKind;
  /** Smoked-exchange product: vessels are never asset-tagged. */
  isExchange: boolean;
  /** Seed default; the per-org `processing_method.lodge_cappable` row is authoritative. */
  lodgeCappable: boolean;
  sort: number;
  /** `head_off` seeds inactive: a manager add-on with no matrix or yield rows. */
  isActive: boolean;
}

export const FRESH = "fresh" satisfies MethodCode;
export const FRESH_SPLIT = ["fillets", "portions"] as const satisfies readonly ServiceMethodCode[];
export const SMOKING = "smoking" satisfies MethodCode;

const NAMES: Record<MethodCode, string> = {
  fresh: "Fresh",
  portions: "Portions",
  fillets: "Fillets",
  smoking: "Smoking",
  smoked_exchange_traditional: "Smoked exchange (traditional)",
  smoked_exchange_cajun: "Smoked exchange (cajun)",
  freeze: "Freeze",
  head_off: "Head off",
  as_is: "As-is",
};

export function isMethodCode(value: string): value is MethodCode {
  return (METHOD_CODES as readonly string[]).includes(value);
}

export function isExchangeMethod(code: MethodCode): boolean {
  return SEED.smoked_exchange_codes.includes(code);
}

export const METHODS: Readonly<Record<MethodCode, Method>> = Object.fromEntries(
  METHOD_CODES.map((code, i): [MethodCode, Method] => [
    code,
    {
      code,
      name: NAMES[code],
      shorthand: SEED.processing_shorthand[code] ?? null,
      kind: code === FRESH ? "virtual" : "service",
      isExchange: isExchangeMethod(code),
      lodgeCappable: true,
      sort: (i + 1) * 10,
      isActive: code !== "head_off",
    },
  ]),
) as Record<MethodCode, Method>;
