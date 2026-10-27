# Kovario — Payments

Card-present payment is a **provider interface** chosen per terminal. The register,
settlement, storage batch and release code never know which provider is behind it.
Subscription billing for tenants (Stripe Billing) is a separate concern (`WP-22`).

## 1. Interface (`packages/payments/src/provider.ts`)

```ts
export type PaymentOutcome =
  | 'approved' | 'declined' | 'cancelled' | 'indeterminate' | 'error';

export interface CardMeta {
  brand?: string; last4?: string;
  entryMode?: 'chip' | 'contactless' | 'swipe' | 'manual' | 'keyed';
  authCode?: string; hostResponseCode?: string; declineReason?: string;
  token?: string;                       // provider card token, if any (never PAN)
}

export interface SaleResult {
  outcome: PaymentOutcome;
  approvedAmount?: number;              // may be < requested (partial approval)
  providerRef: string;                  // our reference echoed back
  providerTxn?: string;                 // provider's transaction id
  card?: CardMeta;
  message?: string;                     // cashier-facing, plain language
  raw: unknown;                         // scrubbed, for payment_event
}

export interface PaymentProvider {
  readonly kind: 'manual' | 'dejavoo_spin' | 'stripe_terminal';
  sale(req: { terminal: TerminalConfig; amount: number; ref: string; timeoutMs: number }): Promise<SaleResult>;
  abort(req: { terminal: TerminalConfig; ref: string }): Promise<{ ok: boolean; raw: unknown }>;
  status(req: { terminal: TerminalConfig; ref: string; txn?: string }): Promise<SaleResult>;
  reverse(req: { terminal: TerminalConfig; originalRef: string; originalTxn?: string; amount?: number }):
    Promise<{ outcome: 'voided' | 'refunded' | 'declined' | 'error'; providerTxn?: string; raw: unknown }>;
  refund(req: { terminal: TerminalConfig; amount: number; ref: string; originalTxn?: string }):
    Promise<{ outcome: 'refunded' | 'declined' | 'error'; providerTxn?: string; raw: unknown }>;
  scrub(x: unknown): unknown;           // redact secrets/PAN for logging
}
```

`TerminalConfig = payment_terminal.config + { secret: string }` where `secret` is
resolved server-side from Vault by `secret_ref`. The sale call blocks up to ~150 s, so
the `/api/payments/*` route handlers run on the **Node runtime with `export const
maxDuration = 300`** (Fluid Compute; 300 s is the Hobby maximum — DECISION-18); never on the Edge
runtime. **Providers run only in server code**
(Edge Function `payments` or Next route handlers with service role); the browser calls
`/api/payments/{sale,abort,status,reverse,refund}` with the register order id.

## 2. Register flow (provider-agnostic)

1. Cashier taps **Charge**. Server creates `payment(state=pending, attempt=n,
   provider_ref = <uuid-hex-24>-<attempt>)` and `payment_event(sale_requested)`.
2. Server calls `provider.sale` and **blocks** up to `timeoutMs` (default 120 s +
   30 s transport buffer). UI shows "Present card on terminal" with a **Cancel** button.
3. Cancel → `provider.abort` → UI unblocks **immediately** (do not wait for the original
   sale call to time out); the sale promise's eventual result is reconciled by `status`.
4. Result:
   - `approved` → `payment.approved`, run **paid hooks** (settle charges, mark settlements,
     release storage batches, audit rows), print receipt.
   - `declined` → toast with the bank's reason; payment line stays open for retry
     (new ref, attempt+1).
   - `cancelled` → quiet toast; line stays open.
   - `indeterminate` → **must** call `status(ref)`; show result; if still unknown, mark
     the payment `indeterminate` and block retry until a manager resolves (status check
     or manual mark). Never charge twice.
   - `error` → "could not reach terminal" + retry.
5. Receipt is Kovario's (PDF/HTML) with card meta from `payment`; the terminal's own
   receipt is suppressed.

Paid hooks are one Postgres function `apply_paid_register_order(order_id, payment_id)`
with the locking protocol (intake row first for storage batches; session → vessels →
intakes for settlements) and per-item savepoints so one failure never blocks sibling
items (S8). A release failure after money captured stamps `release_failed` + note
outside the savepoint and surfaces a manager remedy (S6).

## 3. Adapter: `manual`
No terminal. Cashier records tender type + reference (cash, check, external terminal
ref). `sale` returns `approved` immediately with `entryMode: 'manual'`. Used by tenants
without an integrated processor and for comp/COMP flows (reason required).

## 4. Adapter: `dejavoo_spin` (CSP's processor — build first)

Protocol = **SPIn REST v2** (iPOSPays). Everything below is confirmed in production by
the CSP reference (`cs_pos_dejavoo`); keep these exact behaviours.

- **Endpoint:** `POST https://<host>/v2/Payment/<Op>` with `Op ∈ Sale | Void | Return |
  Status | AbortTransaction`. `host` is per terminal config (sandbox `dev.spinpos.net`,
  production `spinpos.net`) — configurable, never hardcoded.
- **Auth in the JSON body**, not headers: `Authkey`, `Tpn`. Send `Tpn`; **omit
  `RegisterId`** unless a terminal config explicitly sets it (an empty or placeholder
  RegisterId trips "Register not found" 2003).
- Body: `PaymentType:'Credit'`, `Amount` **numeric** (25, not "25.00"), `ReferenceId`,
  `PrintReceipt:'No'`, `GetReceipt:'No'`, `CaptureSignature:false`,
  `GetExtendedData:true`, `SPInProxyTimeout:<secs>` (default 120). Void/Return/Status
  add `OriginalReferenceId` / `OriginalTransNum`.
- **Synchronous**: the HTTP call blocks until the customer finishes on the terminal or
  the proxy timeout. HTTP timeout = SPInProxyTimeout + 30 s.
- 4xx with a JSON body is **parsed, not thrown** (validation errors come as JSON under
  `GeneralResponse`); only 5xx / unparseable bodies are transport errors.
- **Classify on `StatusCode` (4-digit), never `ResultCode`.** Map:
  - approved: `0000`, `0001` (partial approval), `1500` (signature not captured)
  - cancelled: `1012`
  - declined: `1015`
  - indeterminate (→ run Status): `1000 1005 1006 1030 1999 2001 2007 2008 2010 2011 2110`
  - bad_request (dev fix): `1002 1003 1004 1007 1008 1013 1016 2006 2102 2201`
  - config_error (reach processor): `1009 1017 1019 1020 1024 2002 2003 2004 2005 2101`
  - lookup_error: `1001 1010 1011 2009 2301`
- **Issuer declines arrive as 1012** (terminal auto-aborts). Read `HostResponseCode`:
  `'00'` = approval, anything else = **declined** with the bank's reason surfaced to the
  cashier. Never show a decline as "cancelled".
- Card meta: merge `CardData`, `ExtData` (string `k=v,k=v` or object) and
  `ExtendedDataByApplication.<brand>`; last4 under `Last4|AcntLast4|AcntLast`; token
  under `IPosToken|iPOSToken|Token`.
- **Reversal:** send `/Void` with the original ref; Dejavoo voids if pre-batch else
  refunds; store `ProcessedAs`. No void-window tracking.
- Multi-terminal = one TPN per terminal; each is its own batch. Auto-batch is host
  side; no settle button.
- Scrub `Authkey`, `AccountNumber`, `Pan`, `FullCardNumber` before any log.
- Provisioning notes (ops, not code): terminal must have SPIn enabled on-device with
  matching Register/TPN and host URLs; cash disabled via S.T.E.A.M so all txns default
  to card; the terminal is **live money** — test with small amounts and void.

## 5. Adapter: `stripe_terminal`

- Server creates a `PaymentIntent` (`capture_method: automatic`, `payment_method_types:
  ['card_present']`, `metadata: {org_id, payment_id}`) and uses **server-driven**
  integration: `terminal.readers.processPaymentIntent(reader_id, {payment_intent})`,
  then polls `readers.retrieve` / `paymentIntents.retrieve` until `succeeded`,
  `requires_payment_method` (declined), or cancelled; `cancel_action` for abort.
- Connection tokens are issued by the server for any client-side reader discovery.
- Reverse = `refunds.create` (Stripe voids automatically if uncaptured) — same
  `reverse` semantics as above.
- Card meta from `charges.payment_method_details.card_present` (`brand`, `last4`,
  `read_method` → entryMode).
- Webhooks are **not** the trigger for release; the synchronous result is. Webhooks
  (`payment_intent.succeeded`) only reconcile `indeterminate` payments.
- Stripe Connect is **not** used in v1: each tenant supplies its own Stripe keys in
  Vault (DECISION-05).

## 6. Test harness
`packages/payments/test/` has a **fake SPIn server** (HTTP, scriptable StatusCode /
HostResponseCode / delays) and a Stripe mock. Required cases per adapter: approved,
partial approval, declined-by-issuer-as-1012, cashier cancel, timeout → status
approved, timeout → status cancelled, transport error, config error, reverse → void,
reverse → refund, duplicate ref rejected, retry uses new ref.
