// `dejavoo_spin` adapter (docs/05-PAYMENTS.md §4): SPIn REST v2 (iPOSPays). Never throws — every
// failure becomes an outcome the register understands, and "never charge twice" drives the
// mapping: anything that may have reached the terminal without a definite answer is
// `indeterminate` (the register then runs Status), and only a request that certainly did not
// reach it, or that SPIn rejected before processing, is a retryable `error`.
import {
  TRANSPORT_BUFFER_MS,
  type PaymentProvider,
  type RefundResult,
  type ReverseResult,
  type SaleResult,
  type TerminalConfig,
} from "../provider.ts";
import { scrubSecrets } from "../scrub.ts";
import { classifyStatusCode, type SpinStatusClass } from "./codes.ts";
import { SpinConfigError, spinTerminal, type SpinTerminal } from "./config.ts";
import { buildSpinBody, spinUrl, type SpinFields, type SpinOp } from "./payload.ts";
import {
  approvedAmount,
  cardMeta,
  generalResponse,
  processedAs,
  transNum,
  type SpinGeneral,
} from "./response.ts";
import { postSpin, SpinTransportError, type SpinFetch } from "./transport.ts";

/** docs/05 §4: scrub these before any log (the shared scrub also masks card numbers). */
export const SPIN_SECRET_KEYS = ["Authkey", "AccountNumber", "Pan", "FullCardNumber"] as const;

/** SPInProxyTimeout for the quick calls (AbortTransaction, Status). */
export const SPIN_QUICK_TIMEOUT_SECS = 15;

export interface DejavooOptions {
  fetch?: SpinFetch;
  /** HTTP timeout = SPInProxyTimeout + this (default 30 s) */
  transportBufferMs?: number;
  /** clock for the Void reference suffix */
  now?: () => number;
}

type Answer =
  | {
      kind: "answer";
      http: number;
      body: Record<string, unknown>;
      g: SpinGeneral;
      cls: Cls;
      raw: unknown;
    }
  | { kind: "transport"; reached: boolean; message: string; raw: unknown };
type Cls = SpinStatusClass | "unknown";

const money = (n: number) => `$${n.toFixed(2)}`;

function codeText(g: SpinGeneral): string {
  const what = g.detailedMessage ?? g.message;
  return `${g.statusCode ?? "no StatusCode"}${what ? ` ${what}` : ""}`;
}

/** The bank's reason, for the cashier. */
function bankReason(g: SpinGeneral): string {
  return (
    g.hostResponseMessage ??
    g.message ??
    (g.hostResponseCode ? `bank code ${g.hostResponseCode}` : "declined by the bank")
  );
}

/**
 * HostResponseCode override: issuer declines arrive as 1012 (the terminal auto-aborts), so a
 * host code that is not `00` on a non-approved answer is a decline — never "cancelled". A `00`
 * on a non-approved answer is conflicting: indeterminate, reconcile by Status.
 */
function hostVerdict(cls: Cls, g: SpinGeneral): "declined" | "indeterminate" | null {
  if (cls === "approved" || !g.hostResponseCode) return null;
  return g.hostResponseCode === "00" ? "indeterminate" : "declined";
}

/** Sale and Status answers → SaleResult. A Status that fails to look up proves nothing. */
function interpret(
  a: Answer,
  ref: string,
  mode: "sale" | "status",
  requested?: number,
): SaleResult {
  const base = { providerRef: ref, raw: a.raw };
  if (a.kind === "transport") {
    return a.reached || mode === "status"
      ? { ...base, outcome: "indeterminate", message: `${a.message} — checking status.` }
      : { ...base, outcome: "error", message: `${a.message}. Nothing was charged; retry.` };
  }
  const { g, cls, body } = a;
  const card = cardMeta(body);
  const providerTxn = transNum(body);

  if (cls === "approved") {
    const amount = approvedAmount(body);
    if (g.statusCode === "0001" && amount === undefined) {
      return {
        ...base,
        outcome: "indeterminate",
        providerTxn,
        card,
        message: "Partial approval without an amount — check status.",
      };
    }
    const approved = amount ?? requested;
    const partial = g.statusCode === "0001" && approved !== undefined;
    return {
      ...base,
      outcome: "approved",
      approvedAmount: approved,
      providerTxn,
      card,
      message: partial
        ? requested !== undefined
          ? `Partially approved: ${money(approved)} of ${money(requested)}. Collect the rest.`
          : `Partially approved: ${money(approved)}.`
        : g.statusCode === "1500"
          ? "Approved (signature not captured)."
          : "Approved.",
    };
  }

  const verdict = hostVerdict(cls, g);
  if (verdict === "declined" || (verdict === null && cls === "declined")) {
    const reason = bankReason(g);
    return {
      ...base,
      outcome: "declined",
      providerTxn,
      card: { ...card, declineReason: reason },
      message: `Declined: ${reason}.`,
    };
  }
  if (verdict === "indeterminate") {
    return {
      ...base,
      outcome: "indeterminate",
      providerTxn,
      card,
      message: `The bank approved but the terminal reported ${codeText(g)} — checking status.`,
    };
  }
  switch (cls) {
    case "cancelled":
      return { ...base, outcome: "cancelled", message: "Cancelled on the terminal." };
    case "bad_request":
    case "config_error":
    case "lookup_error":
      if (mode === "status") {
        return {
          ...base,
          outcome: "indeterminate",
          message: `The terminal could not report this sale (${codeText(g)}). A manager checks the processor.`,
        };
      }
      return {
        ...base,
        outcome: "error",
        message:
          cls === "config_error"
            ? `Terminal setup problem (${codeText(g)}). Check the TPN / register with the processor. Nothing was charged.`
            : `The terminal rejected the request (${codeText(g)}). Nothing was charged.`,
      };
    default:
      return {
        ...base,
        outcome: "indeterminate",
        message: `The terminal did not confirm (${codeText(g)}) — checking status.`,
      };
  }
}

/** Void / Return answers. `performed` = what a successful answer means. */
function interpretReversal<O extends "voided" | "refunded">(
  a: Answer,
  performed: (body: Record<string, unknown>) => O,
): { outcome: O | "declined" | "error" | "indeterminate"; providerTxn?: string; raw: unknown } {
  if (a.kind === "transport") {
    return { outcome: a.reached ? "indeterminate" : "error", raw: a.raw };
  }
  const providerTxn = transNum(a.body);
  if (a.cls === "approved") return { outcome: performed(a.body), providerTxn, raw: a.raw };
  const verdict = hostVerdict(a.cls, a.g);
  if (verdict) return { outcome: verdict, providerTxn, raw: a.raw };
  switch (a.cls) {
    case "declined":
    case "cancelled":
      return { outcome: "declined", providerTxn, raw: a.raw };
    case "bad_request":
    case "config_error":
    case "lookup_error":
      return { outcome: "error", raw: a.raw };
    default:
      return { outcome: "indeterminate", providerTxn, raw: a.raw };
  }
}

export function createDejavooProvider(opts: DejavooOptions = {}): PaymentProvider {
  const fetchImpl: SpinFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const bufferMs = opts.transportBufferMs ?? TRANSPORT_BUFFER_MS;
  const now = opts.now ?? Date.now;
  const scrub = (x: unknown) => scrubSecrets(x, SPIN_SECRET_KEYS);

  async function call(t: SpinTerminal, op: SpinOp, fields: SpinFields): Promise<Answer> {
    const request = buildSpinBody(t, fields);
    try {
      const { http, body } = await postSpin(
        fetchImpl,
        spinUrl(t, op),
        request,
        fields.proxyTimeoutSecs * 1000 + bufferMs,
      );
      const g = generalResponse(body);
      // A 4xx JSON answer without a StatusCode is an HTTP-level refusal: nothing was processed.
      const cls: Cls =
        http >= 400 && !g.statusCode ? "bad_request" : classifyStatusCode(g.statusCode);
      const raw = scrub({
        op,
        http,
        statusClass: cls,
        processedAs: processedAs(body),
        request,
        response: body,
      });
      return { kind: "answer", http, body, g, cls, raw };
    } catch (e) {
      const te =
        e instanceof SpinTransportError
          ? e
          : new SpinTransportError(e instanceof Error ? e.message : String(e), true);
      return {
        kind: "transport",
        reached: te.reached,
        message: te.message,
        raw: scrub({ op, transport: te.message, reached: te.reached, http: te.http, request }),
      };
    }
  }

  /** The terminal settings, or the setup message (nothing is sent). */
  function setup(terminal: TerminalConfig): SpinTerminal | string {
    try {
      return spinTerminal(terminal);
    } catch (e) {
      return e instanceof SpinConfigError ? e.message : "Terminal setup is invalid.";
    }
  }

  /** The terminal's interactive wait: its configured timeout, else the register's. */
  const waitSecs = (t: SpinTerminal, timeoutMs?: number) =>
    t.timeoutSecs ?? Math.max(1, Math.ceil((timeoutMs ?? 120_000) / 1000));

  return {
    kind: "dejavoo_spin",

    async sale({ terminal, amount, ref, timeoutMs }): Promise<SaleResult> {
      const t = setup(terminal);
      if (typeof t === "string") {
        return {
          outcome: "error",
          providerRef: ref,
          message: t,
          raw: { op: "Sale", stage: "setup" },
        };
      }
      let a: Answer;
      try {
        a = await call(t, "Sale", {
          referenceId: ref,
          amount,
          proxyTimeoutSecs: waitSecs(t, timeoutMs),
        });
      } catch (e) {
        // the body could not be built (an amount that is not whole cents): nothing was sent
        return {
          outcome: "error",
          providerRef: ref,
          message: e instanceof Error ? e.message : String(e),
          raw: { op: "Sale", stage: "setup", amount },
        };
      }
      return interpret(a, ref, "sale", amount);
    },

    async abort({ terminal, ref }) {
      const t = setup(terminal);
      if (typeof t === "string")
        return { ok: false, raw: { op: "AbortTransaction", stage: "setup", error: t } };
      const a = await call(t, "AbortTransaction", {
        referenceId: ref,
        proxyTimeoutSecs: SPIN_QUICK_TIMEOUT_SECS,
      });
      return { ok: a.kind === "answer" && a.cls === "approved", raw: a.raw };
    },

    async status({ terminal, ref, txn }): Promise<SaleResult> {
      const t = setup(terminal);
      if (typeof t === "string") {
        return {
          outcome: "indeterminate",
          providerRef: ref,
          message: t,
          raw: { op: "Status", stage: "setup" },
        };
      }
      const a = await call(t, "Status", {
        referenceId: ref,
        originalReferenceId: ref,
        originalTransNum: txn,
        proxyTimeoutSecs: SPIN_QUICK_TIMEOUT_SECS,
      });
      return interpret(a, ref, "status");
    },

    // One /Void with the original ref: Dejavoo voids before the batch, else refunds — the
    // answer's ProcessedAs says which. No void-window tracking. The Void carries its own
    // ReferenceId (a ref is never reused).
    async reverse({ terminal, originalRef, originalTxn, amount }): Promise<ReverseResult> {
      const t = setup(terminal);
      if (typeof t === "string")
        return { outcome: "error", raw: { op: "Void", stage: "setup", error: t } };
      let a: Answer;
      try {
        a = await call(t, "Void", {
          referenceId: `${originalRef}-V${now().toString(36)}`,
          amount,
          originalReferenceId: originalRef,
          originalTransNum: originalTxn,
          proxyTimeoutSecs: waitSecs(t),
        });
      } catch (e) {
        return { outcome: "error", raw: { op: "Void", stage: "setup", error: String(e) } };
      }
      return interpretReversal(a, (body) =>
        /return|refund/i.test(processedAs(body) ?? "") ? "refunded" : "voided",
      ) as ReverseResult;
    },

    async refund({ terminal, amount, ref, originalTxn }): Promise<RefundResult> {
      const t = setup(terminal);
      if (typeof t === "string")
        return { outcome: "error", raw: { op: "Return", stage: "setup", error: t } };
      let a: Answer;
      try {
        a = await call(t, "Return", {
          referenceId: ref,
          amount,
          originalTransNum: originalTxn,
          proxyTimeoutSecs: waitSecs(t),
        });
      } catch (e) {
        return { outcome: "error", raw: { op: "Return", stage: "setup", error: String(e) } };
      }
      return interpretReversal(a, () => "refunded" as const) as RefundResult;
    },

    scrub,
  };
}

export const dejavooProvider: PaymentProvider = createDejavooProvider();
