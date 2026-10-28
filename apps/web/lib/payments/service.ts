// The register's payment flow on the server (docs/05-PAYMENTS.md §2), behind the
// /api/payments/* route handlers. Provider-agnostic: the provider comes from the payment's
// terminal. Writes go through SQL functions only —
//   caller  (the cashier's own JWT, RLS + role checks): payment_begin, payment_for_provider,
//           payment_reverse_begin, register_order;
//   service (service role, this server only): payment_terminal_runtime (Vault secret),
//           payment_record_result, payment_log_event, payment_reverse_record.
// The browser can therefore never mark a payment approved or see a terminal secret, and every
// provider payload is scrubbed by the adapter before it is stored.
import type { FilletryClient, Json } from "db";
import {
  PROVIDER_KINDS,
  SALE_TIMEOUT_MS,
  TENDER_TYPES,
  type PaymentProvider,
  type ProviderKind,
  type SaleResult,
  type Tender,
  type TerminalConfig,
} from "payments";
import { z } from "zod";

export type PaymentsDeps = {
  caller: FilletryClient;
  service: FilletryClient;
  providerFor: (kind: ProviderKind) => PaymentProvider;
  /** terminal wait; default 120 s (the route adds the 30 s transport buffer to maxDuration) */
  timeoutMs?: number;
};

export class PaymentRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "PaymentRequestError";
  }
}

const HTTP_BY_SQLSTATE: Record<string, number> = {
  "42501": 403,
  P0002: 404,
  "55000": 409,
  "23505": 409,
  "22023": 400,
  "22004": 400,
  "23514": 400,
};

type RpcError = { message: string; code?: string | null };

function toRequestError(error: RpcError): PaymentRequestError {
  const code = error.code ?? undefined;
  return new PaymentRequestError(error.message, (code && HTTP_BY_SQLSTATE[code]) || 500, code);
}

/** An rpc result, with SQL errors mapped to HTTP statuses (42501 → 403, P0002 → 404 …). */
export async function unwrap(
  request: PromiseLike<{ data: unknown; error: RpcError | null }>,
): Promise<Json> {
  const { data, error } = await request;
  if (error) throw toRequestError(error);
  return (data ?? null) as Json;
}

export const paymentForProvider = z.object({
  id: z.string(),
  org_id: z.string(),
  state: z.string(),
  provider: z.enum(PROVIDER_KINDS),
  terminal_id: z.string().nullable(),
  amount: z.coerce.number(),
  provider_ref: z.string(),
  provider_txn: z.string().nullable().optional(),
  tender: z.enum(TENDER_TYPES),
  tender_ref: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  order_id: z.string().nullable().optional(),
  replayed: z.boolean().optional(),
});
export type ProviderPayment = z.infer<typeof paymentForProvider>;

const reverseBegun = paymentForProvider.extend({
  kind: z.enum(["reverse", "refund"]),
  reverse_amount: z.coerce.number(),
  refund_ref: z.string(),
  reason: z.string(),
});

const terminalRuntime = z.object({
  config: z.record(z.string(), z.unknown()),
  secret: z.string(),
});

/** The payment's terminal config + its Vault secret (service role). */
export async function terminalFor(
  deps: Pick<PaymentsDeps, "service">,
  p: Pick<ProviderPayment, "terminal_id" | "org_id">,
): Promise<TerminalConfig> {
  if (!p.terminal_id) return { secret: "" };
  const t = terminalRuntime.parse(
    await unwrap(
      deps.service.rpc("payment_terminal_runtime", {
        p_terminal_id: p.terminal_id,
        p_org_id: p.org_id,
      }),
    ),
  );
  return { ...t.config, secret: t.secret };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A provider result as stored: JSON-safe, raw scrubbed by the adapter. */
function stored(result: SaleResult, provider: PaymentProvider | null): Json {
  return JSON.parse(
    JSON.stringify({
      outcome: result.outcome,
      approvedAmount: result.approvedAmount,
      providerRef: result.providerRef,
      providerTxn: result.providerTxn,
      card: result.card,
      message: result.message,
      raw: provider ? provider.scrub(result.raw) : result.raw,
    }),
  ) as Json;
}

export function record(
  deps: Pick<PaymentsDeps, "service">,
  paymentId: string,
  event: "sale_result" | "status_check",
  result: SaleResult,
  provider: PaymentProvider | null,
): Promise<Json> {
  return unwrap(
    deps.service.rpc("payment_record_result", {
      p_payment_id: paymentId,
      p_event: event,
      p_result: stored(result, provider),
    }),
  );
}

/** The payment and its cart as they are now (for replays and no-op calls). */
async function current(deps: PaymentsDeps, paymentId: string, status = "current"): Promise<Json> {
  const payment = await unwrap(
    deps.caller.rpc("payment_for_provider", { p_payment_id: paymentId }),
  );
  const orderId = paymentForProvider.parse(payment).order_id;
  const order = orderId
    ? await unwrap(deps.caller.rpc("register_order", { p_order_id: orderId }))
    : null;
  return { status, payment, order };
}

export async function askStatus(
  provider: PaymentProvider,
  terminal: TerminalConfig,
  p: ProviderPayment,
): Promise<SaleResult> {
  try {
    return await provider.status({
      terminal,
      ref: p.provider_ref,
      txn: p.provider_txn ?? undefined,
    });
  } catch (e) {
    return {
      outcome: "indeterminate",
      providerRef: p.provider_ref,
      message: "Status check failed.",
      raw: { error: message(e) },
    };
  }
}

export type ChargeInput = {
  clientActionId: string;
  orderId: string;
  amount: number;
  terminalId?: string | null;
  tender: Tender["type"];
  tenderRef?: string | null;
  reason?: string | null;
  elevationToken?: string | null;
};

/**
 * Charge (docs/05 §2): pending payment → provider.sale (blocks up to timeoutMs) → result.
 * `indeterminate` is followed at once by a status check; still unknown leaves the payment
 * indeterminate, which blocks the next Charge until a status check or a manager resolves it.
 * A thrown adapter error is treated as indeterminate (the request may have reached the
 * terminal) — never as safe to retry.
 */
export async function chargePayment(deps: PaymentsDeps, input: ChargeInput): Promise<Json> {
  const p = paymentForProvider.parse(
    await unwrap(
      deps.caller.rpc("payment_begin", {
        p_client_action_id: input.clientActionId,
        p_order_id: input.orderId,
        p_amount: input.amount,
        p_terminal_id: input.terminalId ?? undefined,
        p_tender: input.tender,
        p_tender_ref: input.tenderRef ?? undefined,
        p_reason: input.reason ?? undefined,
        p_elevation_token: input.elevationToken ?? undefined,
      }),
    ),
  );
  if (p.replayed) return current(deps, p.id, "replayed");

  let provider: PaymentProvider;
  let terminal: TerminalConfig;
  try {
    provider = deps.providerFor(p.provider);
    terminal = await terminalFor(deps, p);
  } catch (e) {
    // Nothing reached a terminal: an error the cashier can retry.
    return record(
      deps,
      p.id,
      "sale_result",
      {
        outcome: "error",
        providerRef: p.provider_ref,
        message: message(e),
        raw: { stage: "setup" },
      },
      null,
    );
  }

  const tender: Tender | undefined =
    p.tender === "card"
      ? undefined
      : { type: p.tender, reference: p.tender_ref ?? undefined, reason: p.reason ?? undefined };
  let result: SaleResult;
  try {
    result = await provider.sale({
      terminal,
      amount: p.amount,
      ref: p.provider_ref,
      timeoutMs: deps.timeoutMs ?? SALE_TIMEOUT_MS,
      tender,
      context: { orgId: p.org_id, paymentId: p.id },
    });
  } catch (e) {
    result = {
      outcome: "indeterminate",
      providerRef: p.provider_ref,
      message: "Lost contact with the terminal — checking status.",
      raw: { error: message(e) },
    };
  }
  const recorded = await record(deps, p.id, "sale_result", result, provider);
  if (result.outcome !== "indeterminate") return recorded;
  // Ask about the transaction the sale itself reported (e.g. Stripe's PaymentIntent id).
  const asked = { ...p, provider_txn: result.providerTxn ?? p.provider_txn };
  return record(deps, p.id, "status_check", await askStatus(provider, terminal, asked), provider);
}

/**
 * Cashier Cancel (docs/05 §2.3): tells the terminal to abort and returns at once — the UI
 * unblocks without waiting for the sale call; the sale's own request records its outcome
 * (or a status check reconciles it).
 */
export async function abortPayment(
  deps: PaymentsDeps,
  input: { paymentId: string },
): Promise<Json> {
  const p = paymentForProvider.parse(
    await unwrap(deps.caller.rpc("payment_for_provider", { p_payment_id: input.paymentId })),
  );
  if (p.state !== "pending") return current(deps, p.id);
  let ok = false;
  let raw: unknown;
  let provider: PaymentProvider | null = null;
  try {
    provider = deps.providerFor(p.provider);
    const r = await provider.abort({ terminal: await terminalFor(deps, p), ref: p.provider_ref });
    ok = r.ok;
    raw = provider.scrub(r.raw);
  } catch (e) {
    // An adapter's exception text may echo its request (Authkey, card data): scrub it like
    // every other stored provider payload (AGENTS.md rule 5).
    raw = provider ? provider.scrub({ error: message(e) }) : { error: message(e) };
  }
  await unwrap(
    deps.service.rpc("payment_log_event", {
      p_payment_id: p.id,
      p_kind: "abort",
      p_payload: JSON.parse(JSON.stringify({ ok, raw: raw ?? null })) as Json,
    }),
  );
  return current(deps, p.id, ok ? "abort_sent" : "abort_failed");
}

/** Status check (docs/05 §2.4) for a pending or indeterminate payment. */
export async function checkPaymentStatus(
  deps: PaymentsDeps,
  input: { paymentId: string },
): Promise<Json> {
  const p = paymentForProvider.parse(
    await unwrap(deps.caller.rpc("payment_for_provider", { p_payment_id: input.paymentId })),
  );
  if (p.state !== "pending" && p.state !== "indeterminate") return current(deps, p.id);
  let provider: PaymentProvider;
  let terminal: TerminalConfig;
  try {
    provider = deps.providerFor(p.provider);
    terminal = await terminalFor(deps, p);
  } catch (e) {
    throw new PaymentRequestError(message(e), 409);
  }
  return record(deps, p.id, "status_check", await askStatus(provider, terminal, p), provider);
}

export type ReverseInput = {
  clientActionId: string;
  paymentId: string;
  kind: "reverse" | "refund";
  amount?: number | null;
  reason: string;
  elevationToken?: string | null;
};

/**
 * Manager void / refund (docs/04 §11).
 * A failure BEFORE the provider is asked (adapter or terminal setup) is a safe `error`; an
 * exception FROM the provider call is `indeterminate` — the money may already be back — which
 * keeps the reservation with its original ref and blocks every new void / refund until a
 * manager resolves it (payment_reverse_resolve). `reverse` sends the provider a reverse intent for the
 * whole payment and stores what it actually did (void or refund); `refund` returns an amount.
 * A refund never releases anything (S11).
 */
export async function reversePayment(deps: PaymentsDeps, input: ReverseInput): Promise<Json> {
  const p = reverseBegun.parse(
    await unwrap(
      deps.caller.rpc("payment_reverse_begin", {
        p_client_action_id: input.clientActionId,
        p_payment_id: input.paymentId,
        p_kind: input.kind,
        p_reason: input.reason,
        p_amount: input.amount ?? undefined,
        p_elevation_token: input.elevationToken ?? undefined,
      }),
    ),
  );
  if (p.replayed) return current(deps, p.id, "replayed");

  let outcome: { outcome: string; providerTxn?: string; raw: unknown } = {
    outcome: "error",
    raw: { stage: "setup" },
  };
  let provider: PaymentProvider | null = null;
  let terminal: TerminalConfig | null = null;
  try {
    provider = deps.providerFor(p.provider);
    terminal = await terminalFor(deps, p);
  } catch (e) {
    // Nothing reached the provider.
    provider = null;
    terminal = null;
    outcome = { outcome: "error", raw: { stage: "setup", error: message(e) } };
  }
  if (provider && terminal) {
    try {
      outcome =
        p.kind === "reverse"
          ? await provider.reverse({
              terminal,
              originalRef: p.provider_ref,
              originalTxn: p.provider_txn ?? undefined,
              amount: p.reverse_amount,
            })
          : await provider.refund({
              terminal,
              amount: p.reverse_amount,
              ref: p.refund_ref,
              originalTxn: p.provider_txn ?? undefined,
            });
    } catch (e) {
      outcome = { outcome: "indeterminate", raw: { error: message(e) } };
    }
  }
  return unwrap(
    deps.service.rpc("payment_reverse_record", {
      p_payment_id: p.id,
      p_kind: p.kind,
      p_amount: p.reverse_amount,
      p_reason: p.reason,
      p_result: JSON.parse(
        JSON.stringify({
          outcome: outcome.outcome,
          providerTxn: outcome.providerTxn,
          raw: provider ? provider.scrub(outcome.raw) : outcome.raw,
        }),
      ) as Json,
    }),
  );
}
