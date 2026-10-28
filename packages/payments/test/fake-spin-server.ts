// A scriptable fake SPIn REST v2 server (docs/05-PAYMENTS.md §6) on a loopback port. Queue the
// answer to each op (StatusCode, HostResponseCode, amount, card data, delay, HTTP status, raw
// body); an empty queue approves Sales / Returns, voids Voids and answers Status from the
// transactions it has seen. Like the real proxy it:
//   * checks Tpn + Authkey and rejects a RegisterId it does not know (2003 "Register not found");
//   * rejects a non-numeric Amount (validation error as JSON under GeneralResponse, HTTP 400);
//   * rejects a reused ReferenceId (no second charge);
//   * holds a Sale scripted `hold` until AbortTransaction for its ref (cashier Cancel) → 1012;
//   * keeps processing a Sale whose caller gave up (a timeout) and records its outcome, so a
//     later Status reports what really happened.
// The codes the fake uses for its own checks (auth, duplicate ref) are its choice from the
// docs/05 table; the live codes are confirmed by the manual checklist (docs/wp/WP-17.md).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type SpinOp = "Sale" | "Void" | "Return" | "Status" | "AbortTransaction";

export interface SpinScript {
  statusCode?: string;
  hostResponseCode?: string;
  hostResponseMessage?: string;
  message?: string;
  /** Amounts.Amount; defaults to the requested Amount */
  amount?: number;
  transNum?: string;
  /** Void: `Void` or `Return` */
  processedAs?: string;
  cardData?: Record<string, unknown>;
  extData?: string | Record<string, unknown>;
  extendedDataByApplication?: Record<string, unknown>;
  /** answer after this long (the transaction is recorded when it completes) */
  delayMs?: number;
  /** Sale: wait for AbortTransaction of this ref, then answer 1012 */
  hold?: boolean;
  /** HTTP status (default 200; 400 for 1xxx/2xxx validation answers is up to the script) */
  http?: number;
  /** send this text instead of a JSON answer */
  rawBody?: string;
  /** extra top-level fields merged into the answer */
  extra?: Record<string, unknown>;
}

export interface SpinRequest {
  op: SpinOp;
  body: Record<string, unknown>;
}

export interface FakeSpinOptions {
  tpn?: string;
  authkey?: string;
  /** a RegisterId the fake knows; any other RegisterId is 2003 */
  registerId?: string;
  duplicateRefStatusCode?: string;
}

interface Txn {
  op: SpinOp;
  answer: Record<string, unknown>;
}

const APPROVED_CARD = {
  CardType: "VISA",
  EntryType: "Chip",
  Last4: "4242",
  First4: "4111",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FakeSpinServer {
  readonly requests: SpinRequest[] = [];
  /** completed transactions by ReferenceId (Sale / Void / Return) */
  readonly txns = new Map<string, Txn>();
  /** money-moving answers the fake gave (approved Sales) — "never charge twice" */
  charges = 0;
  private readonly scripts = new Map<SpinOp, SpinScript[]>();
  private readonly held = new Map<string, () => void>();
  private readonly refs = new Set<string>();
  private seq = 1000;

  private constructor(
    private readonly server: Server,
    readonly url: string,
    readonly opts: Required<Omit<FakeSpinOptions, "registerId">> & { registerId?: string },
  ) {}

  static async start(opts: FakeSpinOptions = {}): Promise<FakeSpinServer> {
    let self: FakeSpinServer | null = null;
    const server = createServer((req, res) => {
      void self?.handle(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    self = new FakeSpinServer(server, `http://127.0.0.1:${port}`, {
      tpn: opts.tpn ?? "Z8TESTTPN001",
      authkey: opts.authkey ?? "fake-authkey-not-a-secret",
      registerId: opts.registerId,
      duplicateRefStatusCode: opts.duplicateRefStatusCode ?? "1013",
    });
    return self;
  }

  /** The TerminalConfig a test hands the adapter. */
  terminal(extra: Record<string, unknown> = {}) {
    return { endpoint_url: this.url, tpn: this.opts.tpn, secret: this.opts.authkey, ...extra };
  }

  queue(op: SpinOp, ...steps: SpinScript[]): this {
    this.scripts.set(op, [...(this.scripts.get(op) ?? []), ...steps]);
    return this;
  }

  requestsOf(op: SpinOp): Record<string, unknown>[] {
    return this.requests.filter((r) => r.op === op).map((r) => r.body);
  }

  close(): Promise<void> {
    for (const release of this.held.values()) release();
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private send(res: ServerResponse, http: number, body: unknown) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(http, { "content-type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  }

  private general(s: SpinScript, fallback: string) {
    return {
      GeneralResponse: {
        StatusCode: s.statusCode ?? fallback,
        ResultCode: "0",
        Message: s.message ?? (s.statusCode && s.statusCode !== "0000" ? "Error" : "Approved"),
        HostResponseCode: s.hostResponseCode ?? "",
        HostResponseMessage: s.hostResponseMessage ?? "",
      },
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const op = /^\/v2\/Payment\/(Sale|Void|Return|Status|AbortTransaction)$/.exec(
      req.url ?? "",
    )?.[1] as SpinOp | undefined;
    let text = "";
    for await (const chunk of req) text += String(chunk);
    if (!op || req.method !== "POST") return this.send(res, 404, "Not Found");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return this.send(res, 400, this.general({ message: "Invalid JSON" }, "1002"));
    }
    this.requests.push({ op, body });
    const step = this.scripts.get(op)?.shift() ?? {};
    const ref = String(body.ReferenceId ?? "");

    // The proxy's own checks, before anything reaches the terminal.
    if (body.Tpn !== this.opts.tpn) {
      return this.send(res, 400, this.general({ message: "TPN not found" }, "2002"));
    }
    if (body.Authkey !== this.opts.authkey) {
      return this.send(res, 400, this.general({ message: "Invalid Authkey" }, "1017"));
    }
    if ("RegisterId" in body && body.RegisterId !== this.opts.registerId) {
      return this.send(res, 400, this.general({ message: "Register not found" }, "2003"));
    }
    if (
      (op === "Sale" || op === "Return" || op === "Void") &&
      "Amount" in body &&
      typeof body.Amount !== "number"
    ) {
      return this.send(res, 400, this.general({ message: "Amount must be numeric" }, "1002"));
    }
    if (!ref) return this.send(res, 400, this.general({ message: "ReferenceId required" }, "1002"));

    if (op === "AbortTransaction") return this.abort(res, ref, step);
    if (op === "Status") return this.status(res, body, step);

    if (this.refs.has(ref)) {
      return this.send(
        res,
        400,
        this.general({ message: "Duplicate ReferenceId" }, this.opts.duplicateRefStatusCode),
      );
    }
    this.refs.add(ref);

    if (step.hold) {
      const released = await Promise.race([
        new Promise<boolean>((resolve) => this.held.set(ref, () => resolve(true))),
        sleep(10_000).then(() => false),
      ]);
      this.held.delete(ref);
      const answer = this.answer(
        op,
        body,
        released ? { statusCode: "1012", message: "Aborted" } : { statusCode: "2007" },
      );
      this.txns.set(ref, { op, answer });
      return this.send(res, 200, answer);
    }
    if (step.delayMs) await sleep(step.delayMs);
    if (step.rawBody !== undefined) return this.send(res, step.http ?? 200, step.rawBody);
    const answer = this.answer(op, body, step);
    this.txns.set(ref, { op, answer });
    this.send(res, step.http ?? 200, answer);
  }

  private answer(
    op: SpinOp,
    body: Record<string, unknown>,
    s: SpinScript,
  ): Record<string, unknown> {
    const code = s.statusCode ?? "0000";
    const approved = ["0000", "0001", "1500"].includes(code);
    if (op === "Sale" && approved) this.charges++;
    const amount = s.amount ?? (typeof body.Amount === "number" ? body.Amount : undefined);
    return {
      ...this.general(
        { ...s, hostResponseCode: s.hostResponseCode ?? (approved ? "00" : "") },
        code,
      ),
      PaymentType: "Credit",
      TransactionType: op,
      ReferenceId: body.ReferenceId,
      ...(approved
        ? {
            ...(amount !== undefined ? { Amounts: { TotalAmount: amount, Amount: amount } } : {}),
            AuthCode: "A1B2C3",
            TransactionNumber: s.transNum ?? String(++this.seq),
            BatchNumber: "7",
            CardData: s.cardData ?? APPROVED_CARD,
            ...(op === "Void" ? { ProcessedAs: s.processedAs ?? "Void" } : {}),
          }
        : {}),
      ...(s.extData !== undefined ? { ExtData: s.extData } : {}),
      ...(s.extendedDataByApplication
        ? { ExtendedDataByApplication: s.extendedDataByApplication }
        : {}),
      ...s.extra,
    };
  }

  private abort(res: ServerResponse, ref: string, s: SpinScript) {
    const release = this.held.get(ref);
    release?.();
    const code = s.statusCode ?? (release ? "0000" : "1001");
    this.send(
      res,
      s.http ?? 200,
      this.general({ ...s, message: s.message ?? (release ? "Aborted" : "Not found") }, code),
    );
  }

  private status(res: ServerResponse, body: Record<string, unknown>, s: SpinScript) {
    if (s.statusCode || s.rawBody !== undefined || s.http) {
      if (s.rawBody !== undefined) return this.send(res, s.http ?? 200, s.rawBody);
      return this.send(res, s.http ?? 200, this.answer("Status", body, s));
    }
    const ref = String(body.OriginalReferenceId ?? body.ReferenceId ?? "");
    const txn = this.txns.get(ref);
    if (!txn)
      return this.send(res, 200, this.general({ message: "Transaction not found" }, "1001"));
    this.send(res, 200, txn.answer);
  }
}
