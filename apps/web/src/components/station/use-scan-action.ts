"use client";
import { useEffect, useRef, useState } from "react";
import { createStore, get, set } from "idb-keyval";
import { parse, parseManual } from "rules";
import { ScanQueue, type PendingScan, type ScanReply, type ScanRequest } from "./scan-queue";

export function useScanAction(scope: string, send: (request: ScanRequest) => Promise<ScanReply>) {
  const [pending, setPending] = useState(0);
  const [feedback, setFeedback] = useState<(ScanReply & { event: number }) | null>(null);
  const queue = useRef<ScanQueue | null>(null);
  const sequence = useRef(0);
  const show = (reply: ScanReply) => setFeedback({ ...reply, event: ++sequence.current });
  useEffect(() => {
    const store = createStore("filletry-scans", "queue");
    const instance = new ScanQueue(
      {
        read: async () => (await get<PendingScan[]>(scope, store)) ?? [],
        write: (rows) => set(scope, rows, store),
      },
      async (request) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            send(request),
            new Promise<ScanReply>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Scan delivery timed out")), 10_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      },
      setPending,
      show,
      Date.now,
      async (work) => await navigator.locks.request(`scan-storage:${scope}`, work),
      async (work) => await navigator.locks.request(`scan-delivery:${scope}`, work),
    );
    queue.current = instance;
    const drain = (reconnect = false) => {
      // Delivery has its own cross-tab lock; enqueue only waits for a short storage transaction.
      void instance
        .drain(navigator.onLine, reconnect)
        .catch(() =>
          show({ ok: false, reason: "Scan storage unavailable. Keep this station open." }),
        );
    };
    const online = () => drain(true);
    drain();
    const timer = setInterval(drain, 1000);
    window.addEventListener("online", online);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", online);
      queue.current = null;
    };
  }, [scope, send]);
  /**
   * Queues the request and delivers what it can. Resolves true once it is queued (it will be sent,
   * now or on reconnect), false when it was not (station starting, storage failure), so a caller
   * showing a tap as in flight knows to undo that.
   */
  const scan = async (request: ScanRequest): Promise<boolean> => {
    const instance = queue.current;
    if (!instance) {
      show({ ok: false, reason: "Station is starting. Scan again." });
      return false;
    }
    let queued = false;
    try {
      await instance.enqueue(request);
      queued = true;
      if (request.vessel_id) {
        // A tap names a listed vessel: nothing to parse locally.
        show({ ok: true, reason: "Sent — pending confirmation" });
      } else {
        // A typed tag or location may be its bare short code, which only parseManual reads.
        const parsed =
          request.entry_method === "manual" ? parseManual(request.raw) : parse(request.raw);
        show({
          ok: parsed.ok,
          reason: parsed.ok ? "Read locally — pending confirmation" : parsed.reason,
        });
      }
      await instance.drain(navigator.onLine);
    } catch {
      show({ ok: false, reason: "Scan could not be saved. Scan again." });
    }
    return queued;
  };
  return { pending, feedback, scan };
}
