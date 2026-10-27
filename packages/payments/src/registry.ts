// Provider per terminal (DECISION-02): `manual` is always available; the Dejavoo SPIn (WP-17)
// and Stripe Terminal (WP-18) adapters register here when they land.
import { manualProvider } from "./manual.ts";
import type { PaymentProvider, ProviderKind } from "./provider.ts";

export class ProviderUnavailableError extends Error {
  constructor(readonly kind: ProviderKind) {
    super(`The ${kind} payment adapter is not available yet`);
    this.name = "ProviderUnavailableError";
  }
}

const providers: Partial<Record<ProviderKind, PaymentProvider>> = {
  manual: manualProvider,
};

export function providerFor(kind: ProviderKind): PaymentProvider {
  const p = providers[kind];
  if (!p) throw new ProviderUnavailableError(kind);
  return p;
}
