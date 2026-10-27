import type { FilletryClient } from "./clients";
import type { Database, Json } from "./types";
import { withAction } from "./with-action";
/** WP-07/09/13/15 supply a rendered snapshot and the station/device's printer id.
 * No global default, live payment lookup or implicit rerouting on reprint. */
export async function enqueuePrintJob(
  client: FilletryClient,
  clientActionId: string,
  job: {
    printerId: string;
    kind: Database["public"]["Enums"]["print_job_kind"];
    payloadType: "zpl" | "pdf_url";
    payload: string;
    copies?: number;
    source?: Json;
  },
): Promise<Json> {
  return withAction(client, clientActionId, async (id) => {
    const { data, error } = await client.rpc("enqueue_print_job", {
      p_client_action_id: id,
      p_printer_id: job.printerId,
      p_kind: job.kind,
      p_payload_type: job.payloadType,
      p_payload: job.payload,
      p_copies: job.copies ?? 1,
      p_source: job.source ?? {},
    });
    if (error) throw new Error(error.message);
    return data;
  });
}
export function agentOnline(lastSeenAt: string | null, now = Date.now()): boolean {
  return lastSeenAt !== null && now - Date.parse(lastSeenAt) < 90_000;
}
