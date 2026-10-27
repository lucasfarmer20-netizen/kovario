// A scriptable in-memory provider for tests (docs/05-PAYMENTS.md §6). Queue the outcome of
// each call; an empty queue approves sales in full, leaves status unknown and voids reversals.
// Like a real terminal it rejects a reused reference, and a sale scripted to `hold` waits
// for `abort` (cashier Cancel) — the way the Dejavoo call blocks until the customer acts.
import type {
  CardMeta,
  PaymentOutcome,
  PaymentProvider,
  ProviderKind,
  RefundOutcome,
  RefundResult,
  ReverseOutcome,
  ReverseResult,
  SaleResult,
} from "./provider.ts";
import { scrubSecrets } from "./scrub.ts";

export interface FakeSaleStep {
  outcome: PaymentOutcome;
  /** defaults to the requested amount when approved */
  approvedAmount?: number;
  providerTxn?: string;
  card?: CardMeta;
  message?: string;
  delayMs?: number;
  /** wait until abort(ref) is called, then report `cancelled` */
  hold?: boolean;
  /** throw instead of returning (a transport failure the adapter did not map) */
  throws?: string;
}

export interface FakeCall {
  op: "sale" | "abort" | "status" | "reverse" | "refund";
  req: unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FakeProvider implements PaymentProvider {
  readonly calls: FakeCall[] = [];
  private readonly sales: FakeSaleStep[] = [];
  private readonly statuses: FakeSaleStep[] = [];
  private readonly reverses: { outcome: ReverseOutcome; providerTxn?: string }[] = [];
  private readonly refunds: { outcome: RefundOutcome; providerTxn?: string }[] = [];
  private readonly seenRefs = new Set<string>();
  private readonly held = new Map<string, () => void>();
  private txn = 0;

  constructor(readonly kind: ProviderKind = "dejavoo_spin") {}

  queueSale(...steps: FakeSaleStep[]): this {
    this.sales.push(...steps);
    return this;
  }

  queueStatus(...steps: FakeSaleStep[]): this {
    this.statuses.push(...steps);
    return this;
  }

  queueReverse(...steps: { outcome: ReverseOutcome; providerTxn?: string }[]): this {
    this.reverses.push(...steps);
    return this;
  }

  queueRefund(...steps: { outcome: RefundOutcome; providerTxn?: string }[]): this {
    this.refunds.push(...steps);
    return this;
  }

  /** Calls of one kind, in order. */
  callsOf(op: FakeCall["op"]): unknown[] {
    return this.calls.filter((c) => c.op === op).map((c) => c.req);
  }

  private result(step: FakeSaleStep, ref: string, amount?: number): SaleResult {
    const approved = step.outcome === "approved";
    return {
      outcome: step.outcome,
      approvedAmount: step.approvedAmount ?? (approved ? amount : undefined),
      providerRef: ref,
      providerTxn: step.providerTxn ?? (approved ? `FAKE-${++this.txn}` : undefined),
      card:
        step.card ??
        (approved
          ? { brand: "VISA", last4: "4242", entryMode: "chip", authCode: "A1B2C3" }
          : undefined),
      message: step.message,
      raw: { fake: true, outcome: step.outcome },
    };
  }

  async sale(req: Parameters<PaymentProvider["sale"]>[0]): Promise<SaleResult> {
    this.calls.push({ op: "sale", req: this.scrub(req) });
    if (this.seenRefs.has(req.ref)) {
      return {
        outcome: "error",
        providerRef: req.ref,
        message: "Duplicate reference",
        raw: { fake: true },
      };
    }
    this.seenRefs.add(req.ref);
    const step = this.sales.shift() ?? { outcome: "approved" };
    if (step.delayMs) await sleep(step.delayMs);
    if (step.throws) throw new Error(step.throws);
    if (step.hold) {
      await new Promise<void>((resolve) => this.held.set(req.ref, resolve));
      return this.result({ outcome: "cancelled", message: "Cancelled at the terminal" }, req.ref);
    }
    return this.result(step, req.ref, req.amount);
  }

  abort(req: Parameters<PaymentProvider["abort"]>[0]): Promise<{ ok: boolean; raw: unknown }> {
    this.calls.push({ op: "abort", req: this.scrub(req) });
    const release = this.held.get(req.ref);
    this.held.delete(req.ref);
    release?.();
    return Promise.resolve({ ok: true, raw: { fake: true, held: Boolean(release) } });
  }

  status(req: Parameters<PaymentProvider["status"]>[0]): Promise<SaleResult> {
    this.calls.push({ op: "status", req: this.scrub(req) });
    return Promise.resolve(
      this.result(this.statuses.shift() ?? { outcome: "indeterminate" }, req.ref),
    );
  }

  reverse(req: Parameters<PaymentProvider["reverse"]>[0]): Promise<ReverseResult> {
    this.calls.push({ op: "reverse", req: this.scrub(req) });
    const step = this.reverses.shift() ?? { outcome: "voided" };
    return Promise.resolve({ ...step, raw: { fake: true, outcome: step.outcome } });
  }

  refund(req: Parameters<PaymentProvider["refund"]>[0]): Promise<RefundResult> {
    this.calls.push({ op: "refund", req: this.scrub(req) });
    const step = this.refunds.shift() ?? { outcome: "refunded" };
    return Promise.resolve({ ...step, raw: { fake: true, outcome: step.outcome } });
  }

  scrub(x: unknown): unknown {
    return scrubSecrets(x);
  }
}
