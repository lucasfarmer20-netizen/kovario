import { openScalePort } from "./scale-port";
import type { FilletryClient } from "db";
import { randomUUID } from "node:crypto";
import { Toledo8217Stream, StableScale } from "./scale";
import { retry } from "./index";
export async function startScales(
  client: FilletryClient,
  onError: () => void,
): Promise<() => void> {
  const { data, error } = await client.from("scale").select("id,port,protocol");
  if (error) throw new Error("Scale configuration unavailable");
  const stops: Array<() => void> = [];
  for (const scale of data ?? []) {
    if (scale.protocol !== "toledo_8217" || !scale.port) continue;
    const parser = new Toledo8217Stream(),
      debounce = new StableScale();
    let chain = Promise.resolve();
    const stop = await openScalePort(
      scale.port,
      (chunk: Buffer) => {
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
      onError,
    );
    stops.push(stop);
  }
  return () => stops.forEach((stop) => stop());
}
