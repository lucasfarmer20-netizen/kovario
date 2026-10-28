// Provider per terminal (DECISION-02): `manual` is always available; Stripe Terminal (WP-18) is
// registered; the Dejavoo SPIn adapter (WP-17) registers here when it lands.
import { manualProvider } from "./manual.ts";
import type { PaymentProvider, ProviderKind } from "./provider.ts";
import { stripeTerminalProvider } from "./stripe-terminal.ts";

export class ProviderUnavailableError extends Error {
  constructor(readonly kind: ProviderKind) {
    super(`The ${kind} payment adapter is not available yet`);
    this.name = "ProviderUnavailableError";
  }
}

const providers: Partial<Record<ProviderKind, PaymentProvider>> = {
  manual: manualProvider,
  stripe_terminal: stripeTerminalProvider,
};

export function providerFor(kind: ProviderKind): PaymentProvider {
  const p = providers[kind];
  if (!p) throw new ProviderUnavailableError(kind);
  return p;
}
