// A Dejavoo terminal's config (docs/05-PAYMENTS.md §4). `payment_terminal.config` holds the
// non-secret fields; the Authkey arrives as `TerminalConfig.secret`, resolved from Vault by the
// terminal's `secret_ref`. The host is per terminal (sandbox `dev.spinpos.net`, production
// `spinpos.net`) — never hardcoded.
import type { TerminalConfig } from "../provider.ts";

/** `SPInProxyTimeout` bounds (s): the sale + status must fit the route's 300 s maxDuration. */
export const SPIN_MIN_TIMEOUT_SECS = 30;
export const SPIN_MAX_TIMEOUT_SECS = 180;
export const SPIN_DEFAULT_TIMEOUT_SECS = 120;

export interface SpinTerminal {
  /** `https://<host>[:port]`, no path */
  baseUrl: string;
  tpn: string;
  /** sent only when the terminal config sets one (an empty one trips 2003) */
  registerId?: string;
  authkey: string;
  /** the terminal's own SPInProxyTimeout, when its config sets one */
  timeoutSecs?: number;
}

export class SpinConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpinConfigError";
  }
}

const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1"]);

/**
 * `spinpos.net`, `https://spinpos.net` or `https://dev.spinpos.net:443` → `https://<host>[:port]`.
 * Plain `http` is accepted only for a loopback host (the fake SPIn server, local dev): the body
 * carries the Authkey. Returns null for anything else (a path, a query, credentials, junk).
 */
export function normalizeSpinEndpoint(input: string): string | null {
  const raw = input.trim().toLowerCase().replace(/\/+$/, "");
  if (!raw) return null;
  const m = /^(?:(https?):\/\/)?([^/:?#@\s]+)(?::(\d{1,5}))?$/.exec(raw);
  if (!m) return null;
  const [, scheme = "https", host = "", port] = m;
  if (!HOST.test(host)) return null;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null;
  if (scheme === "http" && !LOOPBACK.has(host)) return null;
  return `${scheme}://${host}${port ? `:${port}` : ""}`;
}

const TPN = /^[A-Za-z0-9]{4,32}$/;

function text(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  return v.trim() || undefined;
}

/** The terminal's SPIn settings, or a SpinConfigError naming what is missing (no request made). */
export function spinTerminal(t: TerminalConfig): SpinTerminal {
  const endpoint = text(t.endpoint_url);
  const baseUrl = endpoint ? normalizeSpinEndpoint(endpoint) : null;
  if (!baseUrl) {
    throw new SpinConfigError(
      "Terminal setup: the SPIn endpoint host is missing or invalid (e.g. spinpos.net).",
    );
  }
  const tpn = text(t.tpn);
  if (!tpn || !TPN.test(tpn)) throw new SpinConfigError("Terminal setup: the TPN is missing.");
  const authkey = typeof t.secret === "string" ? t.secret.trim() : "";
  if (!authkey) {
    throw new SpinConfigError("Terminal setup: no Authkey — set the terminal's secret ref.");
  }
  let timeoutSecs: number | undefined;
  if (t.timeout_secs !== undefined && t.timeout_secs !== null && t.timeout_secs !== "") {
    const n = Number(t.timeout_secs);
    if (!Number.isInteger(n) || n < SPIN_MIN_TIMEOUT_SECS || n > SPIN_MAX_TIMEOUT_SECS) {
      throw new SpinConfigError(
        `Terminal setup: timeout must be ${SPIN_MIN_TIMEOUT_SECS}–${SPIN_MAX_TIMEOUT_SECS} seconds.`,
      );
    }
    timeoutSecs = n;
  }
  return { baseUrl, tpn, registerId: text(t.register_id), authkey, timeoutSecs };
}
