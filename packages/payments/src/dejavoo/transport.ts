// The SPIn HTTP call (docs/05-PAYMENTS.md §4). Synchronous: the POST blocks until the customer
// finishes on the terminal or the proxy times out, so the HTTP timeout is SPInProxyTimeout plus
// a transport buffer. A 4xx with a JSON body is an answer (validation errors arrive as JSON
// under GeneralResponse) and is parsed, not thrown; only 5xx, unparseable bodies and network
// failures are transport errors.

export type SpinFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface SpinHttpAnswer {
  http: number;
  body: Record<string, unknown>;
}

/**
 * `reached` = the request may have got to the terminal (timeout, reset, 5xx, junk reply), so
 * the outcome is unknown; false = it certainly did not (connection refused, DNS) — safe to retry.
 */
export class SpinTransportError extends Error {
  constructor(
    message: string,
    readonly reached: boolean,
    readonly http?: number,
  ) {
    super(message);
    this.name = "SpinTransportError";
  }
}

/** Socket errors raised before a byte of the request left this host. */
const NOT_SENT = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ERR_INVALID_URL",
]);

function errorCode(e: unknown): string | undefined {
  for (let cur: unknown = e, i = 0; cur && typeof cur === "object" && i < 4; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}

export async function postSpin(
  fetchImpl: SpinFetch,
  url: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<SpinHttpAnswer> {
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    if (isTimeout(e)) {
      throw new SpinTransportError(`No answer from the terminal within ${timeoutMs} ms`, true);
    }
    const code = errorCode(e);
    throw new SpinTransportError(
      `Could not reach the terminal${code ? ` (${code})` : ""}`,
      !code || !NOT_SENT.has(code),
    );
  }
  if (res.status >= 500) {
    throw new SpinTransportError(`The SPIn proxy answered HTTP ${res.status}`, true, res.status);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SpinTransportError(
      `The SPIn proxy answered HTTP ${res.status} without a JSON body`,
      true,
      res.status,
    );
  }
  return { http: res.status, body: parsed as Record<string, unknown> };
}
