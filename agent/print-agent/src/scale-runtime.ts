import { openScalePort } from "./scale-port";
import type { FilletryClient } from "db";
import { randomUUID } from "node:crypto";
import { Toledo8217Stream, StableScale } from "./scale";
import { retry } from "./index";

/** Optional scale failures must never prevent the print queue from starting. */
export async function startScales(
  client: FilletryClient,
  onError: () => void,
): Promise<() => void> {
  const stops: Array<() => void> = [];
  let closed = false;
  let configTimer: ReturnType<typeof setTimeout> | undefined;
  let configDelay = 1000;
  const loadConfiguration = async () => {
    let scales;
    try {
      const { data, error } = await client.from("scale").select("id,port,protocol");
      if (closed) return;
      if (error) throw new Error("Scale configuration unavailable");
      scales = data ?? [];
    } catch {
      if (closed) return;
      onError();
      configTimer = setTimeout(() => {
        void loadConfiguration();
      }, configDelay);
      configDelay = Math.min(configDelay * 2, 30_000);
      return;
    }
    for (const scale of scales) {
      if (closed) return;
      if (scale.protocol !== "toledo_8217" || !scale.port) continue;
      const path = scale.port;
      let stopped = false;
      let stopPort: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let delay = 1000;
      let chain = Promise.resolve();
      const connect = async () => {
        const parser = new Toledo8217Stream(),
          debounce = new StableScale();
        let failed = false;
        const disconnected = () => {
          if (stopped || failed) return;
          failed = true;
          onError();
          stopPort?.();
          stopPort = undefined;
          timer = setTimeout(() => {
            void connect();
          }, delay);
          delay = Math.min(delay * 2, 30_000);
        };
        try {
          const close = await openScalePort(
            path,
            (chunk: Buffer) => {
              if (stopped || failed) return;
              delay = 1000;
              for (const sample of parser.push(chunk)) {
                const accepted = debounce.update(sample, Date.now());
                if (!accepted) continue;
                const id = randomUUID();
                chain = chain
                  .then(async () => {
                    await retry(async () => {
                      const r = await client.rpc("record_scale_reading", {
                        p_client_action_id: id,
                        p_scale_id: scale.id,
                        p_weight: accepted.weightLb,
                        p_stable: true,
                      });
                      if (r.error) throw new Error("Scale delivery unavailable");
                    });
                  })
                  .catch(() => {
                    debounce.retryFailed();
                    onError();
                  });
              }
            },
            disconnected,
          );
          if (stopped || failed) close();
          else stopPort = close;
        } catch {
          disconnected();
        }
      };
      stops.push(() => {
        stopped = true;
        clearTimeout(timer);
        stopPort?.();
        stopPort = undefined;
      });
      await connect();
    }
  };
  void loadConfiguration();
  return () => {
    closed = true;
    clearTimeout(configTimer);
    stops.forEach((stop) => stop());
  };
}
