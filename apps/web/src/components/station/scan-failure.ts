import type { ScanReply } from "./scan-queue";

/** Terminal replies are acknowledged; network, rate-limit and server failures remain retryable. */
export function permanentScanFailure(error: unknown): ScanReply | null {
  let source = error;
  for (let depth = 0; depth < 4 && source !== null && typeof source === "object"; depth++) {
    const code = "code" in source && typeof source.code === "string" ? source.code : "";
    const status = "status" in source && typeof source.status === "number" ? source.status : 0;
    const name = "name" in source && typeof source.name === "string" ? source.name : "";
    if (
      status === 401 ||
      /^28|^PGRST30[123]$/.test(code) ||
      (name.startsWith("Auth") && [400, 403, 422].includes(status))
    ) {
      return { ok: false, reason: "station_sign_in_required" };
    }
    if (code === "42501" || status === 403) return { ok: false, reason: "scan_not_permitted" };
    if (code === "23505" || status === 409) return { ok: false, reason: "scan_conflict" };
    if (/^(22|23)/.test(code) || [400, 422].includes(status)) {
      return { ok: false, reason: "scan_request_rejected" };
    }
    source = "cause" in source ? source.cause : null;
  }
  return null;
}
