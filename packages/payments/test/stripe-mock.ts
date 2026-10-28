// A scriptable in-memory Stripe API for the stripe_terminal adapter tests (docs/05-PAYMENTS.md
// §6). It answers the endpoints the adapter uses through a fetch-compatible function and keeps
// PaymentIntent and reader-action state the way Stripe's server-driven Terminal API does:
//   * a PaymentIntent processed on a reader stays `requires_payment_method` while the reader
//     action is `in_progress`; the scripted customer then approves (in full or partially),
//     declines, cancels, or keeps the reader waiting (`hold`) until `cancel_action`;
//   * the script advances once per PaymentIntent retrieval (`afterPolls`);
//   * Idempotency-Key replays (same params → `idempotent-replayed: true`, different → 400);
//   * failure injection per request (`network` before acting, `lost` after acting, any status)
//     and a full outage.
// No real key is ever used: tests generate one per run.
import type { StripeFetch } from "../src/stripe-terminal.ts";

export type CustomerAction =
  "approve" | "decline" | "customer_cancel" | "hold" | "paid_connection_error";

export interface ReaderScript {
  action: CustomerAction;
  /** PaymentIntent retrievals before the customer acts (default 1) */
  afterPolls?: number;
  /** cents actually authorised (partial approval) */
  amountReceived?: number;
  readMethod?: string;
  brand?: string;
  last4?: string;
  decline?: { code?: string; decline_code?: string; message?: string };
  /** cancel_action answers terminal_reader_busy (the card is being authorised) */
  authorising?: boolean;
}

export type Failure =
  | "network"
  | "lost"
  | { status: number; error?: { type?: string; code?: string; message?: string } };

export interface MockCall {
  method: string;
  path: string;
  params: Record<string, string>;
  headers: Record<string, string>;
}

interface Intent {
  id: string;
  object: "payment_intent";
  status: string;
  amount: number;
  amount_received: number;
  currency: string;
  capture_method: string;
  client_secret: string;
  metadata: Record<string, string>;
  latest_charge: Charge | null;
  last_payment_error: Record<string, unknown> | null;
  refunded: number;
}

interface Charge {
  id: string;
  object: "charge";
  captured: boolean;
  payment_method_details: { card_present: Record<string, unknown> };
}

interface Reader {
  id: string;
  object: "terminal.reader";
  offline: boolean;
  action: {
    type: "process_payment_intent";
    status: "in_progress" | "succeeded" | "failed";
    failure_code: string | null;
    failure_message: string | null;
    process_payment_intent: { payment_intent: string };
  } | null;
  script: ReaderScript | null;
  polls: number;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const stripeError = (status: number, type: string, message: string, code?: string) =>
  json(status, { error: { type, message, code } });

export class StripeMock {
  readonly calls: MockCall[] = [];
  readonly intents = new Map<string, Intent>();
  readonly readers = new Map<string, Reader>();
  private readonly idem = new Map<string, { params: string; status: number; body: unknown }>();
  private readonly scripts: ReaderScript[] = [];
  private readonly failures: { match: string; failure: Failure }[] = [];
  private down = false;
  private seq = 0;
  refundStatus = "succeeded";

  constructor(
    readonly key: string,
    readerIds: string[] = ["tmr_A"],
  ) {
    for (const id of readerIds) this.addReader(id);
  }

  addReader(id: string): Reader {
    const r: Reader = {
      id,
      object: "terminal.reader",
      offline: false,
      action: null,
      script: null,
      polls: 0,
    };
    this.readers.set(id, r);
    return r;
  }

  /** What the next customers at a reader do, in order (default: approve on the first poll). */
  script(...steps: ReaderScript[]): this {
    this.scripts.push(...steps);
    return this;
  }

  /** The next request whose "METHOD /path" starts with `match` fails this way. */
  failOn(match: string, failure: Failure, times = 1): this {
    for (let i = 0; i < times; i++) this.failures.push({ match, failure });
    return this;
  }

  /** Every request fails at the network until `outage(false)`. */
  outage(on = true): this {
    this.down = on;
    return this;
  }

  /** Requests to "METHOD /path" in order; a trailing `*` matches a prefix. */
  callsTo(match: string): MockCall[] {
    const prefix = match.endsWith("*") ? match.slice(0, -1) : null;
    return this.calls.filter((c) => {
      const call = `${c.method} ${c.path}`;
      return prefix !== null ? call.startsWith(prefix) : call === match;
    });
  }

  intent(id: string): Intent {
    const pi = this.intents.get(id);
    if (!pi) throw new Error(`no PaymentIntent ${id}`);
    return pi;
  }

  /** A PaymentIntent created outside a sale (e.g. authorised but uncaptured, for a void). */
  seedIntent(over: Partial<Intent> & { amount: number; status: string }): Intent {
    const pi = this.newIntent(over.amount, over.metadata ?? {}, over.capture_method ?? "automatic");
    Object.assign(pi, over);
    if (over.status === "succeeded" || over.status === "requires_capture") {
      pi.amount_received = over.status === "succeeded" ? (over.amount_received ?? over.amount) : 0;
      pi.latest_charge = this.charge({ action: "approve" }, over.status === "succeeded");
    }
    return pi;
  }

  /** The customer finishes at the reader while the server cannot see it (e.g. an outage). */
  finish(readerId: string, action: CustomerAction = "approve"): void {
    const r = this.readers.get(readerId);
    if (!r?.action) throw new Error("reader has no action");
    this.apply(r, { ...(r.script ?? { action }), action });
  }

  readonly fetch: StripeFetch = async (url, init) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const path = u.pathname;
    const params = Object.fromEntries(
      method === "GET" ? u.searchParams : new URLSearchParams(String(init.body ?? "")),
    );
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    this.calls.push({ method, path, params, headers });
    if (this.down) throw new TypeError("fetch failed");
    const i = this.failures.findIndex((f) => `${method} ${path}`.startsWith(f.match));
    const failure = i >= 0 ? (this.failures.splice(i, 1)[0]?.failure ?? null) : null;
    if (failure === "network") throw new TypeError("fetch failed");
    if (failure && failure !== "lost") {
      return json(failure.status, failure.error ? { error: failure.error } : {});
    }
    const res = await this.handle(method, path, params, headers);
    if (failure === "lost") throw new TypeError("socket hang up");
    return res;
  };

  // --------------------------------------------------------------------------------------------

  private id(prefix: string): string {
    return `${prefix}_${String(++this.seq).padStart(6, "0")}`;
  }

  private newIntent(amount: number, metadata: Record<string, string>, capture: string): Intent {
    const id = this.id("pi");
    const pi: Intent = {
      id,
      object: "payment_intent",
      status: "requires_payment_method",
      amount,
      amount_received: 0,
      currency: "usd",
      capture_method: capture,
      client_secret: `${id}_secret_${this.seq}`,
      metadata,
      latest_charge: null,
      last_payment_error: null,
      refunded: 0,
    };
    this.intents.set(id, pi);
    return pi;
  }

  private charge(s: ReaderScript, captured: boolean): Charge {
    return {
      id: this.id("ch"),
      object: "charge",
      captured,
      payment_method_details: {
        card_present: {
          brand: s.brand ?? "visa",
          last4: s.last4 ?? "4242",
          read_method: s.readMethod ?? "contact_emv",
          receipt: { authorization_code: "123456", authorization_response_code: "00" },
        },
      },
    };
  }

  private intentJson(pi: Intent, params: Record<string, string>) {
    const expand = Object.entries(params)
      .filter(([k]) => k.startsWith("expand["))
      .map(([, v]) => v);
    const { refunded: _refunded, ...rest } = pi;
    void _refunded;
    return {
      ...rest,
      latest_charge: expand.includes("latest_charge")
        ? pi.latest_charge
        : (pi.latest_charge?.id ?? null),
    };
  }

  private metadata(params: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      const m = /^metadata\[(.+)\]$/.exec(k);
      if (m?.[1]) out[m[1]] = v;
    }
    return out;
  }

  private readerOf(pi: Intent): Reader | undefined {
    return [...this.readers.values()].find(
      (r) => r.action?.process_payment_intent.payment_intent === pi.id,
    );
  }

  private apply(r: Reader, s: ReaderScript): void {
    const pi = this.intent(r.action!.process_payment_intent.payment_intent);
    const action = r.action!;
    switch (s.action) {
      case "approve":
      case "paid_connection_error":
        pi.status = "succeeded";
        pi.amount_received = s.amountReceived ?? pi.amount;
        pi.latest_charge = this.charge(s, true);
        action.status = s.action === "approve" ? "succeeded" : "failed";
        if (s.action === "paid_connection_error") action.failure_code = "connection_error";
        break;
      case "decline":
        pi.last_payment_error = {
          type: "card_error",
          code: s.decline?.code ?? "card_declined",
          decline_code: s.decline?.decline_code ?? "insufficient_funds",
          message: s.decline?.message ?? "Your card has insufficient funds.",
          payment_method: { card_present: { brand: s.brand ?? "visa", last4: s.last4 ?? "0002" } },
        };
        action.status = "failed";
        action.failure_code = "card_declined";
        action.failure_message = String(pi.last_payment_error.message);
        break;
      case "customer_cancel":
        action.status = "failed";
        action.failure_code = "customer_canceled";
        action.failure_message = "The customer canceled the transaction.";
        break;
      case "hold":
        break;
    }
  }

  private idempotent(
    headers: Record<string, string>,
    params: Record<string, string>,
    run: () => Response,
  ): Response | Promise<Response> {
    const key = headers["idempotency-key"];
    if (!key) return run();
    const fingerprint = JSON.stringify(params);
    const seen = this.idem.get(key);
    if (seen) {
      if (seen.params !== fingerprint) {
        return stripeError(
          400,
          "idempotency_error",
          "Keys for idempotent requests can only be used with the same parameters they were first used with.",
        );
      }
      return json(seen.status, seen.body, { "idempotent-replayed": "true" });
    }
    const res = run();
    return res
      .clone()
      .json()
      .then((body) => {
        this.idem.set(key, { params: fingerprint, status: res.status, body });
        return res;
      });
  }

  private handle(
    method: string,
    path: string,
    params: Record<string, string>,
    headers: Record<string, string>,
  ): Response | Promise<Response> {
    if (headers.authorization !== `Bearer ${this.key}`) {
      return stripeError(401, "invalid_request_error", "Invalid API Key provided: rk_test_****");
    }
    let m: RegExpExecArray | null;

    if (method === "POST" && path === "/v1/payment_intents") {
      return this.idempotent(headers, params, () => {
        const pi = this.newIntent(
          Number(params.amount),
          this.metadata(params),
          params.capture_method ?? "automatic",
        );
        return json(200, this.intentJson(pi, params));
      });
    }
    if (method === "GET" && path === "/v1/payment_intents/search") {
      const ref = /metadata\['provider_ref'\]:'([^']*)'/.exec(params.query ?? "")?.[1];
      const data = [...this.intents.values()].filter((pi) => pi.metadata.provider_ref === ref);
      return json(200, {
        object: "search_result",
        data: data.map((pi) => this.intentJson(pi, {})),
      });
    }
    if ((m = /^\/v1\/payment_intents\/([^/]+)$/.exec(path)) && method === "GET") {
      const pi = this.intents.get(m[1] ?? "");
      if (!pi)
        return stripeError(
          404,
          "invalid_request_error",
          "No such payment_intent",
          "resource_missing",
        );
      const r = this.readerOf(pi);
      if (r?.action?.status === "in_progress" && r.script) {
        r.polls++;
        if (r.polls >= (r.script.afterPolls ?? 1)) this.apply(r, r.script);
      }
      return json(200, this.intentJson(pi, params));
    }
    if ((m = /^\/v1\/payment_intents\/([^/]+)\/cancel$/.exec(path)) && method === "POST") {
      const pi = this.intents.get(m[1] ?? "");
      if (!pi)
        return stripeError(
          404,
          "invalid_request_error",
          "No such payment_intent",
          "resource_missing",
        );
      if (
        ![
          "requires_payment_method",
          "requires_capture",
          "requires_confirmation",
          "requires_action",
        ].includes(pi.status)
      ) {
        return stripeError(
          400,
          "invalid_request_error",
          `You cannot cancel this PaymentIntent because it has a status of ${pi.status}.`,
          "payment_intent_unexpected_state",
        );
      }
      pi.status = "canceled";
      const r = this.readerOf(pi);
      if (r?.action?.status === "in_progress") {
        r.action.status = "failed";
        r.action.failure_code = "canceled";
      }
      return json(200, this.intentJson(pi, params));
    }
    if ((m = /^\/v1\/terminal\/readers\/([^/]+)$/.exec(path)) && method === "GET") {
      const r = this.readers.get(m[1] ?? "");
      if (!r)
        return stripeError(404, "invalid_request_error", "No such reader", "resource_missing");
      const { script: _s, polls: _p, offline: _o, ...reader } = r;
      void _s;
      void _p;
      void _o;
      return json(200, reader);
    }
    if (
      (m = /^\/v1\/terminal\/readers\/([^/]+)\/process_payment_intent$/.exec(path)) &&
      method === "POST"
    ) {
      return this.idempotent(headers, params, () => {
        const r = this.readers.get(m![1] ?? "");
        if (!r)
          return stripeError(404, "invalid_request_error", "No such reader", "resource_missing");
        if (r.offline) {
          return stripeError(
            400,
            "invalid_request_error",
            "Reader is currently offline.",
            "terminal_reader_offline",
          );
        }
        if (r.action?.status === "in_progress" && r.script?.authorising) {
          return stripeError(
            409,
            "invalid_request_error",
            "Reader is currently busy.",
            "terminal_reader_busy",
          );
        }
        const pi = this.intents.get(params.payment_intent ?? "");
        if (!pi || pi.status !== "requires_payment_method") {
          return stripeError(
            400,
            "invalid_request_error",
            "PaymentIntent is in an invalid state.",
            "intent_invalid_state",
          );
        }
        r.action = {
          type: "process_payment_intent",
          status: "in_progress",
          failure_code: null,
          failure_message: null,
          process_payment_intent: { payment_intent: pi.id },
        };
        r.script = this.scripts.shift() ?? { action: "approve" };
        r.polls = 0;
        return json(200, { id: r.id, object: r.object, action: r.action });
      });
    }
    if ((m = /^\/v1\/terminal\/readers\/([^/]+)\/cancel_action$/.exec(path)) && method === "POST") {
      const r = this.readers.get(m[1] ?? "");
      if (!r)
        return stripeError(404, "invalid_request_error", "No such reader", "resource_missing");
      if (r.action?.status === "in_progress" && r.script?.authorising) {
        return stripeError(
          409,
          "invalid_request_error",
          "Reader is currently busy.",
          "terminal_reader_busy",
        );
      }
      if (r.action?.status !== "in_progress") {
        return stripeError(
          400,
          "invalid_request_error",
          "Reader has no action to cancel.",
          "terminal_reader_action_unavailable",
        );
      }
      r.action.status = "failed";
      r.action.failure_code = "canceled";
      r.action.failure_message = "The action was canceled.";
      return json(200, { id: r.id, object: r.object, action: r.action });
    }
    if (method === "POST" && path === "/v1/refunds") {
      return this.idempotent(headers, params, () => {
        const pi = this.intents.get(params.payment_intent ?? "");
        if (!pi)
          return stripeError(
            404,
            "invalid_request_error",
            "No such payment_intent",
            "resource_missing",
          );
        if (pi.status !== "succeeded") {
          return stripeError(
            400,
            "invalid_request_error",
            "This PaymentIntent does not have a successful charge to refund.",
            "charge_not_refundable",
          );
        }
        const remaining = pi.amount_received - pi.refunded;
        const amount = params.amount ? Number(params.amount) : remaining;
        if (amount > remaining || amount <= 0) {
          return stripeError(
            400,
            "invalid_request_error",
            "Refund amount is greater than the unrefunded amount.",
            "amount_too_large",
          );
        }
        if (this.refundStatus === "succeeded" || this.refundStatus === "pending")
          pi.refunded += amount;
        return json(200, {
          id: this.id("re"),
          object: "refund",
          amount,
          status: this.refundStatus,
          payment_intent: pi.id,
          charge: params["expand[0]"] === "charge" ? pi.latest_charge : pi.latest_charge?.id,
          metadata: this.metadata(params),
        });
      });
    }
    if (method === "POST" && path === "/v1/terminal/connection_tokens") {
      return json(200, {
        object: "terminal.connection_token",
        secret: `pst_test_${this.id("tok")}`,
        location: params.location,
      });
    }
    return stripeError(
      404,
      "invalid_request_error",
      `Unrecognized request URL (${method}: ${path})`,
    );
  }
}
