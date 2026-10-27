// Card-present payment provider interface (docs/05-PAYMENTS.md §1). The register, settlement,
// storage batch and release code never know which provider is behind a terminal. Providers
// run only in server code (the /api/payments/* route handlers); the browser never sees a
// terminal secret.

export const PROVIDER_KINDS = ["manual", "dejavoo_spin", "stripe_terminal"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export type PaymentOutcome = "approved" | "declined" | "cancelled" | "indeterminate" | "error";

export type EntryMode = "chip" | "contactless" | "swipe" | "manual" | "keyed";

export interface CardMeta {
  brand?: string;
  last4?: string;
  entryMode?: EntryMode;
  authCode?: string;
  hostResponseCode?: string;
  declineReason?: string;
  /** provider card token, if any (never PAN) */
  token?: string;
}

export interface SaleResult {
  outcome: PaymentOutcome;
  /** may be < requested (partial approval) */
  approvedAmount?: number;
  /** our reference echoed back */
  providerRef: string;
  /** provider's transaction id */
  providerTxn?: string;
  card?: CardMeta;
  /** cashier-facing, plain language */
  message?: string;
  /** scrubbed, for payment_event */
  raw: unknown;
}

/**
 * `payment_terminal.config` (non-secret: endpoint_url, tpn, register_id, stripe_reader_id)
 * plus `secret`, resolved server-side from Vault by the terminal's `secret_ref`.
 */
export type TerminalConfig = { readonly [key: string]: unknown } & { readonly secret: string };

/**
 * How a non-card payment was tendered. The `manual` adapter records it (cash, check, an
 * external terminal's ref, or a manager-approved COMP with its reason); card adapters
 * ignore it. Additive to the docs/05 §1 signature.
 */
export const TENDER_TYPES = ["card", "cash", "check", "external", "comp"] as const;
export type TenderType = (typeof TENDER_TYPES)[number];
export interface Tender {
  type: TenderType;
  reference?: string;
  reason?: string;
}

export interface SaleRequest {
  terminal: TerminalConfig;
  amount: number;
  ref: string;
  timeoutMs: number;
  tender?: Tender;
}

export type ReverseOutcome = "voided" | "refunded" | "declined" | "error";
export type RefundOutcome = "refunded" | "declined" | "error";

export interface ReverseResult {
  outcome: ReverseOutcome;
  providerTxn?: string;
  raw: unknown;
}

export interface RefundResult {
  outcome: RefundOutcome;
  providerTxn?: string;
  raw: unknown;
}

export interface PaymentProvider {
  readonly kind: ProviderKind;
  sale(req: SaleRequest): Promise<SaleResult>;
  abort(req: { terminal: TerminalConfig; ref: string }): Promise<{ ok: boolean; raw: unknown }>;
  status(req: { terminal: TerminalConfig; ref: string; txn?: string }): Promise<SaleResult>;
  reverse(req: {
    terminal: TerminalConfig;
    originalRef: string;
    originalTxn?: string;
    amount?: number;
  }): Promise<ReverseResult>;
  refund(req: {
    terminal: TerminalConfig;
    amount: number;
    ref: string;
    originalTxn?: string;
  }): Promise<RefundResult>;
  /** redact secrets/PAN for logging */
  scrub(x: unknown): unknown;
}

/** The terminal wait (docs/05 §2): 120 s on the terminal + a 30 s transport buffer. */
export const SALE_TIMEOUT_MS = 120_000;
export const TRANSPORT_BUFFER_MS = 30_000;
