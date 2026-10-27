export type ScanRequest = {
  /** Persist the originating wave with the scan, including across reconnects. */
  wave_id?: string;
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

export type QueueLock = <T>(work: () => Promise<T>) => Promise<T>;

/** Independent promise chains for storage transactions and delivery, unless browser locks are supplied. */
function serialLock(): QueueLock {
  let serial: Promise<unknown> = Promise.resolve();
  return (work) => {
    const result = serial.then(work);
    serial = result.catch(() => undefined);
    return result;
  };
}

/** Delivery is FIFO; storage locks never span network requests. */
export class ScanQueue {
  constructor(
    private store: QueueStore,
    private send: (request: ScanRequest) => Promise<ScanReply>,
    private changed: (pending: number) => void,
    private replied: (reply: ScanReply) => void,
    private now = Date.now,
    private lockStorage: QueueLock = serialLock(),
    private lockDelivery: QueueLock = serialLock(),
  ) {}
  enqueue(request: ScanRequest) {
    return this.lockStorage(async () => {
      const rows = await this.store.read();
      rows.push({ request, attempts: 0, nextAt: 0 });
      await this.store.write(rows);
      this.changed(rows.length);
    });
  }
  drain(online = true, reconnect = false) {
    return this.lockDelivery(async () => {
      while (true) {
        const head = await this.lockStorage(async () => {
          const rows = await this.store.read();
          this.changed(rows.length);
          return rows[0];
        });
        if (!online || !head || (!reconnect && head.nextAt > this.now())) return;
        let reply: ScanReply;
        try {
          reply = await this.send(head.request);
        } catch {
          await this.lockStorage(async () => {
            const rows = await this.store.read();
            const pending = rows.find(
              (row) => row.request.client_action_id === head.request.client_action_id,
            );
            if (pending) {
              pending.nextAt = this.now() + retryDelay(pending.attempts++);
              await this.store.write(rows);
            }
          });
          return;
        }
        await this.lockStorage(async () => {
          const rows = await this.store.read();
          const index = rows.findIndex(
            (row) => row.request.client_action_id === head.request.client_action_id,
          );
          if (index !== -1) rows.splice(index, 1);
          await this.store.write(rows);
          this.changed(rows.length);
        });
        this.replied(reply);
        reconnect = false;
      }
    });
  }
}
