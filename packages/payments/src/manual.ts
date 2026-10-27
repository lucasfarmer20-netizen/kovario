// `manual` adapter (docs/05-PAYMENTS.md §3): no terminal. The cashier records the tender type
// and a reference (cash, check, an external terminal's ref); `sale` is approved at once with
// entryMode 'manual'. COMP (a manager-approved waiver) needs a reason. Used by tenants without
// an integrated processor and always available.
import type { PaymentProvider, SaleResult, Tender } from "./provider.ts";
import { scrubSecrets } from "./scrub.ts";

function tenderError(ref: string, message: string, tender: Tender | undefined): SaleResult {
  return {
    outcome: "error",
    providerRef: ref,
    message,
    raw: scrubSecrets({ tender: tender ?? null }),
  };
}

function label(t: Tender): string {
  switch (t.type) {
    case "cash":
      return "Cash";
    case "check":
      return t.reference ? `Check #${t.reference}` : "Check";
    case "external":
      return `External terminal ref ${t.reference ?? ""}`.trim();
    default:
      return "COMP";
  }
}

export const manualProvider: PaymentProvider = {
  kind: "manual",

  sale({ amount, ref, tender }) {
    if (!tender || tender.type === "card") {
      return Promise.resolve(
        tenderError(ref, "Choose cash, check, external terminal or COMP.", tender),
      );
    }
    const reference = tender.reference?.trim() || undefined;
    if ((tender.type === "check" || tender.type === "external") && !reference) {
      return Promise.resolve(
        tenderError(ref, `A ${tender.type} payment needs its reference.`, tender),
      );
    }
    if (tender.type === "comp" && !tender.reason?.trim()) {
      return Promise.resolve(tenderError(ref, "A COMP needs a reason.", tender));
    }
    const recorded = { ...tender, reference };
    return Promise.resolve({
      outcome: "approved",
      approvedAmount: amount,
      providerRef: ref,
      providerTxn: reference,
      card: { entryMode: "manual" },
      message: `${label(recorded)} recorded.`,
      raw: scrubSecrets({ tender: recorded, amount }),
    });
  },

  abort() {
    return Promise.resolve({ ok: true, raw: { manual: true } });
  },

  // A manual payment is decided when it is recorded; there is no terminal to ask afterwards.
  status({ ref }) {
    return Promise.resolve({
      outcome: "indeterminate",
      providerRef: ref,
      message: "No terminal to ask — a manager marks this payment.",
      raw: { manual: true },
    });
  },

  // The cashier hands the money back; the register records that the provider "voided" it.
  reverse() {
    return Promise.resolve({ outcome: "voided", raw: { manual: true } });
  },

  refund({ amount }) {
    return Promise.resolve({ outcome: "refunded", raw: { manual: true, amount } });
  },

  scrub(x) {
    return scrubSecrets(x);
  },
};
