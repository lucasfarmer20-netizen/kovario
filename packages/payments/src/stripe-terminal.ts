// `stripe_terminal` adapter (docs/05-PAYMENTS.md §5), server-driven: the server creates a
// PaymentIntent, hands it to the reader (`terminal.readers.processPaymentIntent`) and polls the
// reader + PaymentIntent until it succeeds, is declined or is cancelled. Plain fetch, no Stripe
// SDK. Each tenant brings its own restricted key (`rk_…`, DECISION-05), resolved from Vault by
// the terminal's `secret_ref`; `payment_terminal.config` carries the reader id
// (`stripe_reader_id`), the location (`stripe_location_id`, for connection tokens) and the
// Vault name of the webhook signing secret (`webhook_secret_ref`).
//
// Never charge twice: a PaymentIntent that did not succeed is cancelled before the sale reports
// `cancelled` / `declined`, so a retry (new ref → new PaymentIntent) can never meet a stale one
// that a reader could still collect. When Stripe cannot be reached the answer is
// `indeterminate` with the PaymentIntent id, and `status` settles it later.
// Never log request headers from this module: they carry the key.
import type {
  CardMeta,
  EntryMode,
  PaymentProvider,
  RefundResult,
  ReverseResult,
  SaleResult,
  TerminalConfig,
} from "./provider.ts";
import { scrubSecrets } from "./scrub.ts";

/** Pinned so every tenant account answers in the same shape (`latest_charge`, reader action). */
export const STRIPE_API_VERSION = "2024-06-20";
const API = "https://api.stripe.com";

export type StripeFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface StripeTerminalOptions {
  fetch?: StripeFetch;
  apiBase?: string;
  /** reader / PaymentIntent poll interval while the customer is at the reader */
  pollIntervalMs?: number;
  /** one Stripe request; a slower answer is a transport error */
  requestTimeoutMs?: number;
  /** how long the reader may not show our payment before the sale gives up on it */
  readerPickupMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

// Stripe REST ---------------------------------------------------------------------------------

type Params = { [key: string]: string | number | boolean | null | undefined | Params | string[] };

/** application/x-www-form-urlencoded with Stripe's bracket notation. */
export function stripeFormEncode(params: Params, prefix = ""): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      v.forEach((item, i) =>
        parts.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`),
      );
    } else if (typeof v === "object") {
      parts.push(stripeFormEncode(v, key));
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.filter(Boolean).join("&");
}

/** Stripe answered with an error (4xx): the request was refused. */
export class StripeApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string | null,
    readonly code: string | null,
    readonly declineCode: string | null,
    message: string,
  ) {
    super(message);
    this.name = "StripeApiError";
  }
}

/** No usable answer (network, timeout, 5xx): Stripe may or may not have acted. */
export class StripeTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeTransportError";
  }
}

interface StripeErrorBody {
  error?: { type?: string; code?: string; decline_code?: string; message?: string };
}

interface CardPresentDetails {
  brand?: string | null;
  last4?: string | null;
  read_method?: string | null;
  receipt?: {
    authorization_code?: string | null;
    authorization_response_code?: string | null;
  } | null;
}

interface StripeCharge {
  id: string;
  captured?: boolean;
  authorization_code?: string | null;
  payment_method_details?: { card_present?: CardPresentDetails | null } | null;
}

interface PaymentError {
  type?: string;
  code?: string;
  decline_code?: string;
  message?: string;
  payment_method?: { card_present?: CardPresentDetails | null } | null;
}

export interface StripePaymentIntent {
  id: string;
  status: string;
  amount: number;
  amount_received?: number;
  metadata?: Record<string, string>;
  latest_charge?: string | StripeCharge | null;
  last_payment_error?: PaymentError | null;
}

interface ReaderAction {
  type?: string;
  status?: "in_progress" | "succeeded" | "failed";
  failure_code?: string | null;
  failure_message?: string | null;
  process_payment_intent?: { payment_intent?: string | { id: string } } | null;
}

interface StripeReader {
  id: string;
  action?: ReaderAction | null;
}

interface StripeRefund {
  id: string;
  status?: string;
  charge?: string | StripeCharge | null;
}

interface Answer<T> {
  body: T;
  /** Stripe replayed a stored answer for this Idempotency-Key */
  replayed: boolean;
}

function client(
  secret: string,
  opts: Required<Pick<StripeTerminalOptions, "requestTimeoutMs">> & StripeTerminalOptions,
) {
  const fetchImpl = opts.fetch ?? fetch;
  const base = opts.apiBase ?? API;

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    params: Params = {},
    idempotencyKey?: string,
  ): Promise<Answer<T>> {
    const body = stripeFormEncode(params);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${secret}`,
      "Stripe-Version": STRIPE_API_VERSION,
    };
    if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const url = method === "GET" && body ? `${base}${path}?${body}` : `${base}${path}`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: method === "POST" ? body : undefined,
        signal: AbortSignal.timeout(opts.requestTimeoutMs),
      });
    } catch (e) {
      // The message of a fetch failure never carries the headers.
      throw new StripeTransportError(e instanceof Error ? e.message : "fetch failed");
    }
    const json = (await res.json().catch(() => null)) as (T & StripeErrorBody) | null;
    if (res.status >= 500 || !json) {
      throw new StripeTransportError(`Stripe answered ${res.status}`);
    }
    if (!res.ok) {
      const err = json.error ?? {};
      throw new StripeApiError(
        res.status,
        err.type ?? null,
        err.code ?? null,
        err.decline_code ?? null,
        err.message ?? "stripe_error",
      );
    }
    return { body: json, replayed: res.headers.get("idempotent-replayed") === "true" };
  }

  const enc = encodeURIComponent;
  return {
    createIntent: (p: Params, key: string) =>
      call<StripePaymentIntent>("POST", "/v1/payment_intents", p, key),
    getIntent: (id: string) =>
      call<StripePaymentIntent>("GET", `/v1/payment_intents/${enc(id)}`, {
        expand: ["latest_charge"],
      }).then((a) => a.body),
    cancelIntent: (id: string) =>
      call<StripePaymentIntent>("POST", `/v1/payment_intents/${enc(id)}/cancel`, {
        expand: ["latest_charge"],
      }).then((a) => a.body),
    searchIntents: (query: string) =>
      call<{ data: StripePaymentIntent[] }>("GET", "/v1/payment_intents/search", {
        query,
        limit: 1,
      }).then((a) => a.body.data),
    processIntent: (reader: string, intent: string, key: string) =>
      call<StripeReader>(
        "POST",
        `/v1/terminal/readers/${enc(reader)}/process_payment_intent`,
        { payment_intent: intent },
        key,
      ).then((a) => a.body),
    getReader: (reader: string) =>
      call<StripeReader>("GET", `/v1/terminal/readers/${enc(reader)}`).then((a) => a.body),
    cancelAction: (reader: string) =>
      call<StripeReader>("POST", `/v1/terminal/readers/${enc(reader)}/cancel_action`).then(
        (a) => a.body,
      ),
    createRefund: (p: Params, key?: string) =>
      call<StripeRefund>("POST", "/v1/refunds", p, key).then((a) => a.body),
    connectionToken: (location?: string) =>
      call<{ secret: string }>("POST", "/v1/terminal/connection_tokens", { location }).then(
        (a) => a.body,
      ),
  };
}

type Client = ReturnType<typeof client>;

// Terminal config -----------------------------------------------------------------------------

export interface StripeTerminalSettings {
  readerId: string;
  locationId?: string;
  secret: string;
}

export const STRIPE_READER_ID = /^tmr_[A-Za-z0-9]+$/;
export const STRIPE_LOCATION_ID = /^tml_[A-Za-z0-9]+$/;
const RESTRICTED_KEY = /^rk_(test|live)_[A-Za-z0-9]+$/;

/** The terminal's Stripe settings, or the cashier-facing reason it cannot be used. */
export function stripeTerminalSettings(terminal: TerminalConfig): StripeTerminalSettings | string {
  const readerId = terminal.stripe_reader_id;
  const locationId = terminal.stripe_location_id;
  if (typeof readerId !== "string" || !STRIPE_READER_ID.test(readerId)) {
    return "This terminal has no Stripe reader id (tmr_…) — set it in Admin → Payment terminals.";
  }
  if (!RESTRICTED_KEY.test(terminal.secret)) {
    return "This terminal's Stripe key is missing or is not a restricted key (rk_…) — check its secret in Vault.";
  }
  return {
    readerId,
    locationId:
      typeof locationId === "string" && STRIPE_LOCATION_ID.test(locationId)
        ? locationId
        : undefined,
    secret: terminal.secret,
  };
}

// Mapping -------------------------------------------------------------------------------------

const READ_METHOD: Record<string, EntryMode> = {
  contact_emv: "chip",
  contactless_emv: "contactless",
  contactless_magstripe_mode: "contactless",
  magnetic_stripe_track2: "swipe",
  magnetic_stripe_fallback: "swipe",
};

function cardFrom(cp: CardPresentDetails | null | undefined, charge?: StripeCharge): CardMeta {
  const card: CardMeta = {};
  if (cp?.brand) card.brand = cp.brand.toUpperCase();
  if (cp?.last4) card.last4 = cp.last4;
  const mode = cp?.read_method ? READ_METHOD[cp.read_method] : undefined;
  if (mode) card.entryMode = mode;
  const auth = cp?.receipt?.authorization_code ?? charge?.authorization_code;
  if (auth) card.authCode = auth;
  if (cp?.receipt?.authorization_response_code) {
    card.hostResponseCode = cp.receipt.authorization_response_code;
  }
  return card;
}

/** Card meta of a PaymentIntent: its charge's `card_present` details (docs/05 §5). */
export function stripeCardMeta(pi: StripePaymentIntent): CardMeta | undefined {
  const charge = typeof pi.latest_charge === "object" && pi.latest_charge ? pi.latest_charge : null;
  const cp = charge?.payment_method_details?.card_present;
  if (cp) return cardFrom(cp, charge);
  const err = pi.last_payment_error;
  if (err) {
    return {
      ...cardFrom(err.payment_method?.card_present),
      declineReason: err.message ?? err.decline_code ?? err.code,
    };
  }
  return undefined;
}

/** What we keep of a PaymentIntent / reader for payment_event (no client_secret, no keys). */
function rawOf(pi?: StripePaymentIntent | null, reader?: StripeReader | null, extra?: object) {
  return scrubSecrets(
    JSON.parse(
      JSON.stringify({
        payment_intent: pi
          ? {
              id: pi.id,
              status: pi.status,
              amount: pi.amount,
              amount_received: pi.amount_received,
              last_payment_error: pi.last_payment_error
                ? {
                    type: pi.last_payment_error.type,
                    code: pi.last_payment_error.code,
                    decline_code: pi.last_payment_error.decline_code,
                    message: pi.last_payment_error.message,
                  }
                : undefined,
            }
          : undefined,
        reader_action: reader?.action
          ? {
              status: reader.action.status,
              failure_code: reader.action.failure_code,
              failure_message: reader.action.failure_message,
            }
          : undefined,
        ...extra,
      }),
    ),
    ["client_secret"],
  );
}

function errRaw(e: unknown) {
  if (e instanceof StripeApiError) {
    return { error: { status: e.status, type: e.type, code: e.code, message: e.message } };
  }
  return { error: { transport: e instanceof Error ? e.message : String(e) } };
}

/** The bank's reason, shown to the cashier (docs/05 §4: a decline is never "cancelled"). */
function declinedMessage(reason: string | null | undefined): string {
  return `Declined by the bank: ${(reason ?? "no reason given").replace(/\.+$/, "")}.`;
}

const cents = (amount: number) => Math.round(amount * 100);
const dollars = (c: number) => Math.round(c) / 100;

/**
 * A PaymentIntent that reached a final state as a sale result, or null while it is still open.
 * `canceled` with a payment error was a decline we then cancelled.
 */
function finalResult(
  pi: StripePaymentIntent,
  ref: string,
  reader?: StripeReader | null,
): SaleResult | null {
  const base = { providerRef: ref, providerTxn: pi.id, card: stripeCardMeta(pi) };
  if (pi.status === "succeeded") {
    const received = pi.amount_received ?? pi.amount;
    return {
      ...base,
      outcome: "approved",
      approvedAmount: dollars(received),
      message:
        received < pi.amount
          ? `Partially approved: $${dollars(received).toFixed(2)}.`
          : "Approved.",
      raw: rawOf(pi, reader),
    };
  }
  if (pi.status === "canceled") {
    const err = pi.last_payment_error;
    if (err && (err.type === "card_error" || err.decline_code)) {
      return {
        ...base,
        outcome: "declined",
        message: declinedMessage(err.message ?? err.decline_code),
        raw: rawOf(pi, reader),
      };
    }
    return {
      ...base,
      outcome: "cancelled",
      message: "Cancelled — nothing was charged.",
      raw: rawOf(pi, reader),
    };
  }
  return null;
}

function actionIntentId(action: ReaderAction | null | undefined): string | null {
  const pi =
    action?.type === "process_payment_intent"
      ? action.process_payment_intent?.payment_intent
      : null;
  if (!pi) return null;
  return typeof pi === "string" ? pi : pi.id;
}

const READER_MESSAGES: Record<string, string> = {
  terminal_reader_busy:
    "The card reader is busy with another payment — wait for it, then try again.",
  terminal_reader_offline:
    "The card reader is offline — check its power and network, then try again.",
  terminal_reader_hardware_fault:
    "The card reader reports a hardware fault — use another terminal.",
};

function refusedMessage(e: StripeApiError): string {
  const known = e.code ? READER_MESSAGES[e.code] : undefined;
  if (known) return known;
  if (e.status === 401 || e.status === 403) {
    return "Stripe refused this terminal's key — check the restricted key's permissions.";
  }
  return `Stripe refused the payment: ${e.message}`;
}

// Provider ------------------------------------------------------------------------------------

export function createStripeTerminalProvider(options: StripeTerminalOptions = {}): PaymentProvider {
  const opts = {
    pollIntervalMs: 1_000,
    requestTimeoutMs: 20_000,
    readerPickupMs: 10_000,
    ...options,
  };
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const api = (secret: string): Client => client(secret, opts);

  const configError = (ref: string, message: string): SaleResult => ({
    outcome: "error",
    providerRef: ref,
    message,
    raw: { stage: "config" },
  });

  /**
   * Make an open PaymentIntent final by cancelling it: Stripe refuses if it already succeeded,
   * which is then reported as approved. Unknown (Stripe unreachable) is indeterminate.
   */
  async function settleByCancel(
    c: Client,
    id: string,
    ref: string,
    reader: StripeReader | null,
    cancelledMessage: string,
  ): Promise<SaleResult> {
    let pi: StripePaymentIntent;
    try {
      pi = await c.cancelIntent(id);
    } catch (e) {
      if (e instanceof StripeTransportError) {
        return {
          outcome: "indeterminate",
          providerRef: ref,
          providerTxn: id,
          message: "Lost contact with Stripe — checking status.",
          raw: rawOf(null, reader, errRaw(e)),
        };
      }
      try {
        pi = await c.getIntent(id);
      } catch (e2) {
        return {
          outcome: "indeterminate",
          providerRef: ref,
          providerTxn: id,
          message: "Lost contact with Stripe — checking status.",
          raw: rawOf(null, reader, errRaw(e2)),
        };
      }
    }
    const done = finalResult(pi, ref, reader);
    if (done?.outcome === "cancelled") return { ...done, message: cancelledMessage };
    return (
      done ?? {
        outcome: "indeterminate",
        providerRef: ref,
        providerTxn: id,
        message: "Stripe could not cancel the payment — checking status.",
        raw: rawOf(pi, reader),
      }
    );
  }

  /** One look at the PaymentIntent and the reader: a final result, or null to keep waiting. */
  async function observe(
    c: Client,
    s: StripeTerminalSettings,
    id: string,
    ref: string,
    since: number,
  ): Promise<SaleResult | null> {
    const pi = await c.getIntent(id);
    const done = finalResult(pi, ref);
    if (done) return done;
    if (pi.status !== "requires_payment_method") return null; // processing on the network
    const reader = await c.getReader(s.readerId);
    const action = reader.action;
    if (actionIntentId(action) !== id) {
      // The reader is not (or no longer) showing this payment. Give the process call a moment
      // to land, then stop: nothing was collected, and cancelling makes sure nothing will be.
      if (now() - since < opts.readerPickupMs) return null;
      const r = await settleByCancel(
        c,
        id,
        ref,
        reader,
        "The card reader never showed the payment — nothing was charged.",
      );
      return r.outcome === "cancelled" ? { ...r, outcome: "error" } : r;
    }
    if (action?.status !== "failed") return null;
    if (pi.last_payment_error) {
      // Declined by the issuer: cancel this PaymentIntent (a retry is a new one), report why.
      const r = await settleByCancel(c, id, ref, reader, "Cancelled — nothing was charged.");
      return r.outcome === "cancelled"
        ? {
            ...r,
            outcome: "declined",
            message: declinedMessage(pi.last_payment_error.message ?? action.failure_message),
            card: stripeCardMeta(pi),
          }
        : r;
    }
    // Cancelled at the reader (cashier Cancel → cancel_action, the customer, or a reader-side
    // failure such as `connection_error`): the PaymentIntent was not paid unless cancelling it
    // fails because it was.
    return settleByCancel(
      c,
      id,
      ref,
      reader,
      action.failure_code === "customer_canceled"
        ? "The customer cancelled on the reader."
        : "Cancelled on the reader — nothing was charged.",
    );
  }

  const provider: PaymentProvider = {
    kind: "stripe_terminal",

    async sale({ terminal, amount, ref, timeoutMs, context }) {
      const s = stripeTerminalSettings(terminal);
      if (typeof s === "string") return configError(ref, s);
      if (!(amount > 0)) return configError(ref, "Nothing to charge.");
      const c = api(s.secret);
      const deadline = now() + timeoutMs;

      let pi: StripePaymentIntent;
      try {
        const created = await c.createIntent(
          {
            amount: cents(amount),
            currency: "usd",
            payment_method_types: ["card_present"],
            capture_method: "automatic",
            metadata: {
              org_id: context?.orgId,
              payment_id: context?.paymentId,
              provider_ref: ref,
            },
          },
          `filletry-pi-${ref}`,
        );
        if (created.replayed) {
          return {
            outcome: "error",
            providerRef: ref,
            providerTxn: created.body.id,
            message:
              "Duplicate reference — this payment was already sent to Stripe. Check its status.",
            raw: rawOf(created.body, null, { duplicate: true }),
          };
        }
        pi = created.body;
      } catch (e) {
        if (e instanceof StripeApiError) {
          const duplicate = e.type === "idempotency_error" || e.code === "idempotency_key_in_use";
          return {
            outcome: "error",
            providerRef: ref,
            message: duplicate
              ? "Duplicate reference — this payment was already sent to Stripe. Check its status."
              : refusedMessage(e),
            raw: errRaw(e),
          };
        }
        // Even if Stripe created the PaymentIntent, no reader was asked to collect it.
        return {
          outcome: "error",
          providerRef: ref,
          message: "Could not reach Stripe — nothing was charged. Try again.",
          raw: errRaw(e),
        };
      }

      const processedAt = now();
      try {
        await c.processIntent(s.readerId, pi.id, `filletry-process-${ref}`);
      } catch (e) {
        if (e instanceof StripeApiError && e.code !== "terminal_reader_timeout") {
          // The reader never took it; cancel it so nothing can collect it later.
          const r = await settleByCancel(c, pi.id, ref, null, refusedMessage(e));
          return r.outcome === "cancelled"
            ? { ...r, outcome: "error", raw: { ...(r.raw as object), ...errRaw(e) } }
            : r;
        }
        // A reader timeout or a lost answer may still have reached the reader: watch it.
      }

      let lastError: unknown = null;
      for (;;) {
        try {
          const r = await observe(c, s, pi.id, ref, processedAt);
          if (r) return r;
          lastError = null;
        } catch (e) {
          lastError = e;
        }
        if (now() >= deadline) break;
        await sleep(opts.pollIntervalMs);
      }

      // Out of time: clear the reader, then cancel the PaymentIntent (Stripe refuses if the
      // customer's card was approved meanwhile — then it is approved).
      try {
        await c.cancelAction(s.readerId);
      } catch {
        // busy authorising, idle, or unreachable — the PaymentIntent cancel below decides.
      }
      const r = await settleByCancel(
        c,
        pi.id,
        ref,
        null,
        "Timed out at the reader — nothing was charged.",
      );
      return lastError && r.outcome === "indeterminate"
        ? { ...r, raw: { ...(r.raw as object), ...errRaw(lastError) } }
        : r;
    },

    // Cashier Cancel: clear the reader if it is showing THIS payment (never another register's).
    // The sale's own poll then cancels the PaymentIntent and reports `cancelled`.
    async abort({ terminal, ref }) {
      const s = stripeTerminalSettings(terminal);
      if (typeof s === "string") return { ok: false, raw: { stage: "config" } };
      const c = api(s.secret);
      const reader = await c.getReader(s.readerId);
      const id = actionIntentId(reader.action);
      if (!id || reader.action?.status !== "in_progress") {
        return { ok: false, raw: rawOf(null, reader, { reason: "reader_not_collecting" }) };
      }
      const pi = await c.getIntent(id);
      if (pi.metadata?.provider_ref !== ref) {
        return { ok: false, raw: { reason: "reader_busy_with_another_payment" } };
      }
      try {
        const after = await c.cancelAction(s.readerId);
        return { ok: true, raw: rawOf(pi, after) };
      } catch (e) {
        // terminal_reader_busy: the card is being authorised and cannot be interrupted.
        if (e instanceof StripeApiError) return { ok: false, raw: rawOf(pi, reader, errRaw(e)) };
        throw e;
      }
    },

    async status({ terminal, ref, txn }) {
      const s = stripeTerminalSettings(terminal);
      if (typeof s === "string") {
        return { outcome: "indeterminate", providerRef: ref, message: s, raw: { stage: "config" } };
      }
      const c = api(s.secret);
      let id = txn;
      if (!id) {
        // The sale died before it recorded the PaymentIntent id: find it by our ref. Search is
        // eventually consistent, so "not found" stays unknown.
        const found = await c.searchIntents(`metadata['provider_ref']:'${ref.replace(/'/g, "")}'`);
        id = found[0]?.id;
        if (!id) {
          return {
            outcome: "indeterminate",
            providerRef: ref,
            message: "Stripe has no PaymentIntent for this payment yet.",
            raw: { search: "not_found" },
          };
        }
      }
      const pi = await c.getIntent(id);
      if (pi.metadata?.provider_ref && pi.metadata.provider_ref !== ref) {
        return {
          outcome: "indeterminate",
          providerRef: ref,
          providerTxn: id,
          message: "That PaymentIntent belongs to another payment.",
          raw: { mismatch: true },
        };
      }
      const done = finalResult(pi, ref);
      if (done) return done;
      if (pi.status !== "requires_payment_method") {
        return {
          outcome: "indeterminate",
          providerRef: ref,
          providerTxn: id,
          message: "Stripe is still processing the payment.",
          raw: rawOf(pi),
        };
      }
      const reader = await c.getReader(s.readerId);
      if (actionIntentId(reader.action) === id && reader.action?.status === "in_progress") {
        return {
          outcome: "indeterminate",
          providerRef: ref,
          providerTxn: id,
          message: "The payment is still on the card reader.",
          raw: rawOf(pi, reader),
        };
      }
      // Not paid and not on the reader: cancel it so it can never be collected, then report.
      const r = await settleByCancel(
        c,
        id,
        ref,
        reader,
        "Not paid — the payment was cancelled at Stripe.",
      );
      if (r.outcome === "cancelled" && pi.last_payment_error) {
        return {
          ...r,
          outcome: "declined",
          message: declinedMessage(pi.last_payment_error.message),
        };
      }
      return r;
    },

    // Void / refund the whole remaining payment: an uncaptured PaymentIntent is cancelled
    // (voided), a captured one refunded (docs/05 §5).
    async reverse({ terminal, originalRef, originalTxn, amount }): Promise<ReverseResult> {
      const s = stripeTerminalSettings(terminal);
      if (typeof s === "string") return { outcome: "error", raw: { stage: "config", message: s } };
      if (!originalTxn) return { outcome: "error", raw: { reason: "no_payment_intent" } };
      const c = api(s.secret);
      try {
        const pi = await c.getIntent(originalTxn);
        if (pi.status === "requires_capture") {
          const voided = await c.cancelIntent(originalTxn);
          return voided.status === "canceled"
            ? { outcome: "voided", providerTxn: voided.id, raw: rawOf(voided) }
            : { outcome: "indeterminate", raw: rawOf(voided) };
        }
        // No Idempotency-Key: a reverse returns what is left, so Stripe itself refuses a second
        // one (more than the remaining amount), and a stored "failed" answer is never replayed.
        const refund = await c.createRefund({
          payment_intent: originalTxn,
          amount: amount !== undefined ? cents(amount) : undefined,
          metadata: { provider_ref: originalRef, kind: "reverse" },
          expand: ["charge"],
        });
        const charge = typeof refund.charge === "object" ? refund.charge : null;
        return refundOutcome(refund, charge?.captured === false ? "voided" : "refunded");
      } catch (e) {
        return refundFailure(e);
      }
    },

    async refund({ terminal, amount, ref, originalTxn }): Promise<RefundResult> {
      const s = stripeTerminalSettings(terminal);
      if (typeof s === "string") return { outcome: "error", raw: { stage: "config", message: s } };
      if (!originalTxn) return { outcome: "error", raw: { reason: "no_payment_intent" } };
      try {
        const refund = await api(s.secret).createRefund(
          {
            payment_intent: originalTxn,
            amount: cents(amount),
            metadata: { provider_ref: ref, kind: "refund" },
          },
          `filletry-refund-${ref}`,
        );
        return refundOutcome(refund, "refunded" as const);
      } catch (e) {
        return refundFailure(e);
      }
    },

    scrub(x) {
      return scrubSecrets(x, ["client_secret"]);
    },
  };
  return provider;
}

type Settled<O> = { outcome: O; providerTxn?: string; raw: unknown };

function refundOutcome<O extends "voided" | "refunded">(
  refund: StripeRefund,
  ok: O,
): Settled<O | "declined" | "indeterminate"> {
  const raw = { refund: { id: refund.id, status: refund.status } };
  switch (refund.status) {
    case "succeeded":
    case "pending":
      return { outcome: ok, providerTxn: refund.id, raw };
    case "failed":
    case "canceled":
      return { outcome: "declined", providerTxn: refund.id, raw };
    default:
      return { outcome: "indeterminate", providerTxn: refund.id, raw };
  }
}

/** Refused by Stripe → declined (bad key → error); no answer → indeterminate (money may be back). */
function refundFailure(e: unknown): Settled<"declined" | "error" | "indeterminate"> {
  if (e instanceof StripeApiError) {
    return { outcome: e.status === 401 || e.status === 403 ? "error" : "declined", raw: errRaw(e) };
  }
  return { outcome: "indeterminate", raw: errRaw(e) };
}

export const stripeTerminalProvider = createStripeTerminalProvider();

// Connection tokens ---------------------------------------------------------------------------

/**
 * A connection token for client-side reader discovery (docs/05 §5), scoped to the terminal's
 * location when it has one. Only the token's `secret` goes to the browser — never the key.
 */
export async function stripeConnectionToken(
  terminal: TerminalConfig,
  options: StripeTerminalOptions = {},
): Promise<{ secret: string; location?: string }> {
  const s = stripeTerminalSettings(terminal);
  if (typeof s === "string") throw new StripeApiError(400, "config", "terminal_config", null, s);
  const token = await client(s.secret, { requestTimeoutMs: 20_000, ...options }).connectionToken(
    s.locationId,
  );
  return { secret: token.secret, location: s.locationId };
}

// Webhooks ------------------------------------------------------------------------------------

const encoder = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `v1` HMAC-SHA256 of `${t}.${payload}` (Stripe's webhook signature scheme). */
export async function stripeWebhookSignature(
  payload: string,
  secret: string,
  t: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${t}.${payload}`)));
}

/** Verifies a `Stripe-Signature` header (any `v1`), rejecting replays older than 5 minutes. */
export async function verifyStripeWebhook(
  payload: string,
  header: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
  if (!Number.isFinite(t) || sigs.length === 0) return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = await stripeWebhookSignature(payload, secret, t);
  return sigs.some((s) => timingSafeEqual(s, expected));
}

/** The PaymentIntent events that may settle an `indeterminate` payment (docs/05 §5). */
export const STRIPE_RECONCILE_EVENTS = [
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
] as const;

export interface StripeTerminalEvent {
  eventId: string;
  type: (typeof STRIPE_RECONCILE_EVENTS)[number];
  paymentIntentId: string;
  orgId: string | null;
  paymentId: string | null;
  providerRef: string | null;
}

/** A verified event that names one of our payments, or null (anything else is ignored). */
export function parseStripeTerminalEvent(body: unknown): StripeTerminalEvent | null {
  if (!body || typeof body !== "object") return null;
  const ev = body as {
    id?: unknown;
    type?: unknown;
    data?: { object?: { id?: unknown; object?: unknown; metadata?: Record<string, unknown> } };
  };
  const type = STRIPE_RECONCILE_EVENTS.find((t) => t === ev.type);
  const obj = ev.data?.object;
  if (
    !type ||
    typeof ev.id !== "string" ||
    obj?.object !== "payment_intent" ||
    typeof obj.id !== "string"
  ) {
    return null;
  }
  const meta = obj.metadata ?? {};
  const s = (v: unknown) => (typeof v === "string" && v ? v : null);
  if (!s(meta.payment_id)) return null;
  return {
    eventId: ev.id,
    type,
    paymentIntentId: obj.id,
    orgId: s(meta.org_id),
    paymentId: s(meta.payment_id),
    providerRef: s(meta.provider_ref),
  };
}
