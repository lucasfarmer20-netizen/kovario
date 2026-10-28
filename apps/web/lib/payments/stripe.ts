// Stripe Terminal server endpoints beside the provider-agnostic register flow (docs/05-PAYMENTS.md
// §5): connection tokens for client-side reader discovery, and the webhook that reconciles
// `indeterminate` payments only. Webhooks are never the trigger for a release — the synchronous
// sale result is (docs/05 §5); an event for a payment that is pending, approved, declined … is
// acknowledged and ignored. The event itself is not trusted beyond naming the payment: the
// reconciliation asks Stripe (provider.status) and records that answer as a status check.
import { filletryClaims, type AppRole, type FilletryClient, type Json } from "db";
import {
  StripeApiError,
  parseStripeTerminalEvent,
  stripeConnectionToken,
  verifyStripeWebhook,
  type PaymentProvider,
  type ProviderKind,
  type StripeTerminalOptions,
} from "payments";
import { z } from "zod";
import {
  PaymentRequestError,
  askStatus,
  paymentForProvider,
  record,
  terminalFor,
  unwrap,
  type PaymentsDeps,
} from "./service";

/** Who may run the register (payment_begin's roles) — never the print agent. */
const REGISTER_ROLES: readonly AppRole[] = ["owner", "manager", "staff", "cashier", "station"];

/**
 * A connection token for the caller's Stripe terminal. The caller must see the terminal (RLS:
 * same org) and hold a register role; only the token's secret is returned, never the key.
 */
export async function stripeConnectionTokenFor(
  deps: PaymentsDeps & { stripe?: StripeTerminalOptions },
  input: { terminalId: string },
): Promise<Json> {
  const { data: auth } = await deps.caller.auth.getClaims();
  const claims = filletryClaims(auth?.claims);
  if (!claims || !REGISTER_ROLES.includes(claims.appRole)) {
    throw new PaymentRequestError("Only register staff can connect a card reader", 403);
  }
  const { data: t, error } = await deps.caller
    .from("payment_terminal")
    .select("id, org_id, provider, is_active")
    .eq("id", input.terminalId)
    .maybeSingle();
  if (error) throw new PaymentRequestError(error.message, 500);
  if (!t) throw new PaymentRequestError("Terminal not found", 404);
  if (t.provider !== "stripe_terminal") {
    throw new PaymentRequestError("This terminal is not a Stripe reader", 400);
  }
  if (!t.is_active) throw new PaymentRequestError("This terminal is inactive", 409);
  const terminal = await terminalFor(deps, { terminal_id: t.id, org_id: t.org_id });
  try {
    const token = await stripeConnectionToken(terminal, deps.stripe);
    return { secret: token.secret, location: token.location ?? null };
  } catch (e) {
    // Stripe's message never carries the key; the cashier sees why the reader cannot connect.
    if (e instanceof StripeApiError) throw new PaymentRequestError(e.message, 502);
    throw new PaymentRequestError("Could not reach Stripe", 502);
  }
}

export type StripeWebhookDeps = {
  service: FilletryClient;
  providerFor: (kind: ProviderKind) => PaymentProvider;
  /** the terminal's org + signing secret; default: Vault via payment_terminal_webhook_secret */
  webhookSecret?: (terminalId: string) => Promise<{ org_id: string; secret: string }>;
  nowSeconds?: () => number;
};

const webhookSecret = z.object({ org_id: z.string(), secret: z.string().min(1) });
const uuid = z.string().uuid();

export type StripeWebhookResult =
  | { status: "ignored"; reason: string }
  | { status: "reconciled"; outcome: string; recorded: string };

/**
 * Verifies a Stripe event for one terminal's account and, when it names an `indeterminate`
 * Stripe payment of that org, asks Stripe for the PaymentIntent's state and records it.
 */
export async function reconcileStripeWebhook(
  deps: StripeWebhookDeps,
  input: { terminalId: string; payload: string; signature: string | null },
): Promise<StripeWebhookResult> {
  if (!uuid.safeParse(input.terminalId).success) {
    throw new PaymentRequestError("Unknown terminal", 404);
  }
  const hook = webhookSecret.parse(
    deps.webhookSecret
      ? await deps.webhookSecret(input.terminalId)
      : await unwrap(
          deps.service.rpc("payment_terminal_webhook_secret", { p_terminal_id: input.terminalId }),
        ),
  );
  const now = deps.nowSeconds?.();
  if (!(await verifyStripeWebhook(input.payload, input.signature, hook.secret, now))) {
    throw new PaymentRequestError("Invalid signature", 400);
  }
  let body: unknown;
  try {
    body = JSON.parse(input.payload);
  } catch {
    throw new PaymentRequestError("Invalid payload", 400);
  }
  const ev = parseStripeTerminalEvent(body);
  if (!ev?.paymentId || !uuid.safeParse(ev.paymentId).success) {
    return { status: "ignored", reason: "not a Filletry payment event" };
  }
  if (ev.orgId && ev.orgId !== hook.org_id) {
    return { status: "ignored", reason: "another organisation's payment" };
  }

  let p;
  try {
    p = paymentForProvider.parse(
      await unwrap(
        deps.service.rpc("payment_for_webhook", {
          p_payment_id: ev.paymentId,
          p_org_id: hook.org_id,
        }),
      ),
    );
  } catch (e) {
    if (e instanceof PaymentRequestError && e.status === 404) {
      return { status: "ignored", reason: "unknown payment" };
    }
    throw e;
  }
  if (p.provider !== "stripe_terminal")
    return { status: "ignored", reason: "not a Stripe payment" };
  if (p.state !== "indeterminate") {
    return {
      status: "ignored",
      reason: `payment is ${p.state}; webhooks reconcile indeterminate only`,
    };
  }
  if (p.provider_txn && p.provider_txn !== ev.paymentIntentId) {
    return { status: "ignored", reason: "event is for another PaymentIntent" };
  }

  const provider = deps.providerFor("stripe_terminal");
  const terminal = await terminalFor(deps, p);
  const result = await askStatus(provider, terminal, {
    ...p,
    provider_txn: p.provider_txn ?? ev.paymentIntentId,
  });
  const recorded = z
    .object({ status: z.string() })
    .parse(await record(deps, p.id, "status_check", result, provider));
  return { status: "reconciled", outcome: result.outcome, recorded: recorded.status };
}
