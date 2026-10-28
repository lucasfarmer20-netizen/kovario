// Provider per terminal (DECISION-02): `manual` is always available; Dejavoo SPIn (WP-17) is
// registered; the Stripe Terminal adapter (WP-18) registers here when it lands.
import { dejavooProvider } from "./dejavoo/index.ts";
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
  dejavoo_spin: dejavooProvider,
};

export function providerFor(kind: ProviderKind): PaymentProvider {
  const p = providers[kind];
  if (!p) throw new ProviderUnavailableError(kind);
  return p;
}
