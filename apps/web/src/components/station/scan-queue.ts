export type ScanRequest = {
  client_action_id: string;
  raw: string;
  station: "wave" | "rollstock" | "reconcile" | "blast" | "locate" | "boxing";
  operator_session: string | null;
};
export type ScanReply = { ok: boolean; reason: string; scan_id?: string };
export type PendingScan = { request: ScanRequest; attempts: number; nextAt: number };
export interface QueueStore {
  read(): Promise<PendingScan[]>;
  write(rows: PendingScan[]): Promise<void>;
}
export const retryDelay = (attempt: number) => Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));

/** One serialized drain per instance. Durable before send, delete only after acknowledgement. */
export class ScanQueue {
  private serial: Promise<unknown> = Promise.resolve();
  constructor(
    private store: QueueStore,
    private send: (request: ScanRequest) => Promise<ScanReply>,
    private changed: (pending: number) => void,
    private replied: (reply: ScanReply) => void,
    private now = Date.now,
  ) {}
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work);
    this.serial = result.catch(() => undefined);
    return result;
  }
  enqueue(request: ScanRequest) {
    return this.exclusive(async () => {
      const rows = await this.store.read();
      rows.push({ request, attempts: 0, nextAt: 0 });
      await this.store.write(rows);
      this.changed(rows.length);
    });
  }
  drain(online = true, reconnect = false) {
    return this.exclusive(async () => {
      const rows = await this.store.read();
      this.changed(rows.length);
      if (!online) return;
      while (rows.length) {
        const head = rows[0]!;
        if (!reconnect && head.nextAt > this.now()) return;
        let reply: ScanReply;
        try {
          reply = await this.send(head.request);
        } catch {
          head.nextAt = this.now() + retryDelay(head.attempts++);
          await this.store.write(rows);
          return;
        }
        rows.shift();
        await this.store.write(rows);
        this.changed(rows.length);
        this.replied(reply);
        reconnect = false;
      }
    });
  }
}
