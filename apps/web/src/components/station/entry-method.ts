/** How a code reached a station: a hardware scan or typed into "Type code" (issue #84). */
export type EntryMethod = "scan" | "manual";

/** PostgREST request header read by the scan_log trigger (app.scan_log_entry_method). */
export const ENTRY_METHOD_HEADER = "x-filletry-entry-method";

/**
 * Marks a typed code's scan RPC so its scan_log row records entry_method = manual. The RPC,
 * its validation and its client_action_id are exactly those of a hardware scan.
 */
export function withEntryMethod<Q>(query: Q, method: EntryMethod | undefined): Q {
  if (method !== "manual") return query;
  return (query as Q & { setHeader(name: string, value: string): Q }).setHeader(
    ENTRY_METHOD_HEADER,
    "manual",
  );
}
