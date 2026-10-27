// Shippo REST client (docs/07-INTEGRATIONS.md §4): address validate, rate shop (carrier
// allowlist, Rate Check bypass, thin-result retry), buy label per parcel (every label fetched),
// carrier accounts. fetch + timers only — no SDK, no runtime deps — so it runs in a Next.js Node
// route handler and in vitest against recorded fixtures (fake.ts).
//
// Secrets: the API token is sent ONLY to the Shippo API base URL, never to a label URL, and
// never appears in an error message or log line (scrub.ts).
import { cleanAddress } from "./parcels.ts";
import type { Address, AddressCheck, Label, Parcel, Rate, RateShop } from "./types.ts";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type ShippoOptions = {
  apiKey: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
  /** Waits between rate attempts while the carrier set is thin. Length + 1 = max attempts. */
  rateRetryDelaysMs?: readonly number[];
  /** Waits between polls for every parcel's label of a multi-parcel purchase. */
  labelPollDelaysMs?: readonly number[];
};

export const SHIPPO_API = "https://api.goshippo.com";
export const DEFAULT_RATE_RETRY_DELAYS_MS = [1500, 3000, 6000] as const;
export const DEFAULT_LABEL_POLL_DELAYS_MS = [1000, 2000, 3000, 5000, 8000] as const;

/** Carrier allowlist from `org.settings.shipping.carrier_allowlist`: `*` = every carrier. */
export type Allowlist = "*" | readonly string[];

export class ShippoError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly messages: string[] = [],
  ) {
    super(message);
    this.name = "ShippoError";
  }
}

/** Fewer labels than parcels came back. The purchase stands; a retry adopts what exists. */
export class LabelsIncompleteError extends Error {
  constructor(
    readonly ready: number,
    readonly expected: number,
  ) {
    super(`only ${ready} of ${expected} labels are ready at Shippo; retry to fetch the rest`);
    this.name = "LabelsIncompleteError";
  }
}

// Shippo JSON (only the fields we read) ---------------------------------------------------

type ShippoMessage = { source?: string; code?: string; text?: string };
type ShippoRate = {
  object_id: string;
  provider: string;
  carrier_account?: string;
  servicelevel?: { name?: string; token?: string };
  amount: string;
  currency: string;
  estimated_days?: number | null;
};
type ShippoShipment = {
  object_id: string;
  status?: string;
  rates?: ShippoRate[];
  messages?: ShippoMessage[];
  parcels?: ({ object_id: string } | string)[];
};
type ShippoTransaction = {
  object_id: string;
  status: "SUCCESS" | "QUEUED" | "WAITING" | "ERROR" | string;
  rate?: string;
  parcel?: string | null;
  tracking_number?: string;
  label_url?: string;
  messages?: ShippoMessage[];
  object_created?: string;
};
type ShippoCarrierAccount = { object_id: string; carrier: string; active?: boolean };

/** "DHL Express" → "dhl_express": the allowlist token shape (`^[a-z0-9_]{2,40}$`). */
export function carrierToken(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function allows(allowlist: Allowlist, carrier: string): boolean {
  return allowlist === "*" || allowlist.includes(carrier);
}

function texts(messages: ShippoMessage[] | undefined): string[] {
  return (messages ?? []).map((m) => m.text?.trim() ?? "").filter(Boolean);
}

const sleepReal = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function toShippoAddress(a: Address) {
  return { ...cleanAddress(a) };
}

function toShippoParcel(p: Parcel) {
  return {
    length: p.length_in.toFixed(1),
    width: p.width_in.toFixed(1),
    height: p.height_in.toFixed(1),
    distance_unit: "in",
    weight: p.weight_lb.toFixed(2),
    mass_unit: "lb",
  };
}

export type RateShopInput = {
  from: Address;
  to: Address;
  parcels: readonly Parcel[];
  allowlist: Allowlist;
  /** Rate Check: show every carrier the account has, ignoring the allowlist. Never buys. */
  bypassAllowlist?: boolean;
  /** Our reference (SHP-0001) on the Shippo object. */
  metadata?: string;
};

export type BuyInput = {
  shippoShipmentId: string;
  rateId: string;
  parcelCount: number;
  metadata?: string;
};

export function shippoClient(opts: ShippoOptions) {
  const base = (opts.baseUrl ?? SHIPPO_API).replace(/\/+$/, "");
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const sleep = opts.sleep ?? sleepReal;
  const rateDelays = opts.rateRetryDelaysMs ?? DEFAULT_RATE_RETRY_DELAYS_MS;
  const labelDelays = opts.labelPollDelaysMs ?? DEFAULT_LABEL_POLL_DELAYS_MS;
  if (!opts.apiKey) throw new ShippoError(0, "Shippo is not configured for this org");

  async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `ShippoToken ${opts.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      throw new ShippoError(
        res.status,
        `Shippo ${method} ${path.split("?")[0]} failed (${res.status}): ${errorDetail(json)}`,
      );
    }
    return json as T;
  }

  /** Active carrier accounts as allowlist tokens, keyed by account id. */
  async function carrierAccounts(): Promise<Map<string, string>> {
    const page = await api<{ results?: ShippoCarrierAccount[] }>(
      "GET",
      "/carrier_accounts?results=100",
    );
    const out = new Map<string, string>();
    for (const a of page.results ?? []) {
      if (a.active !== false) out.set(a.object_id, carrierToken(a.carrier));
    }
    return out;
  }

  async function validateAddress(address: Address): Promise<AddressCheck> {
    const res = await api<
      Record<string, unknown> & {
        validation_results?: { is_valid?: boolean; messages?: ShippoMessage[] };
      }
    >("POST", "/addresses", { ...toShippoAddress(address), validate: true });
    const valid = res.validation_results?.is_valid === true;
    const pick = (k: keyof Address) =>
      typeof res[k] === "string" ? (res[k] as string) : undefined;
    return {
      valid,
      normalized: valid
        ? cleanAddress({
            name: pick("name") ?? address.name,
            company: pick("company") ?? address.company,
            street1: pick("street1") ?? address.street1,
            street2: pick("street2") ?? address.street2,
            city: pick("city") ?? address.city,
            state: pick("state") ?? address.state,
            zip: pick("zip") ?? address.zip,
            country: pick("country") ?? address.country,
            phone: address.phone,
            email: address.email,
          })
        : null,
      messages: texts(res.validation_results?.messages),
    };
  }

  function toRate(r: ShippoRate, accounts: Map<string, string>): Rate {
    return {
      rateId: r.object_id,
      carrier: (r.carrier_account && accounts.get(r.carrier_account)) || carrierToken(r.provider),
      provider: r.provider,
      service: r.servicelevel?.name ?? r.servicelevel?.token ?? "",
      serviceToken: r.servicelevel?.token ?? "",
      amount: Number(r.amount),
      currency: r.currency,
      estimatedDays: r.estimated_days ?? null,
    };
  }

  /**
   * Rate shop. Carrier APIs lag: when the live carrier set comes back THIN — not just empty —
   * the shipment is re-quoted (up to rateRetryDelaysMs.length more times) and the fullest
   * answer kept. "Thin" = an active carrier the org may use neither quoted nor answered with an
   * error. The allowlist filters what may be bought; Rate Check (`bypassAllowlist`) shows all.
   */
  async function rateShop(input: RateShopInput): Promise<RateShop> {
    if (input.parcels.length === 0)
      throw new ShippoError(0, "a shipment needs at least one parcel");
    const accounts = await carrierAccounts();
    const usable = (c: string) => input.bypassAllowlist || allows(input.allowlist, c);
    const expected = new Set([...accounts.values()].filter(usable));
    const dryIce = input.parcels.reduce((s, p) => s + p.dry_ice_lb, 0);
    const body = {
      address_from: toShippoAddress(input.from),
      address_to: toShippoAddress(input.to),
      parcels: input.parcels.map(toShippoParcel),
      async: false,
      metadata: input.metadata,
      ...(dryIce > 0
        ? { extra: { dry_ice: { contains_dry_ice: true, weight: dryIce.toFixed(2) } } }
        : {}),
    };

    let best: {
      shipment: ShippoShipment;
      rates: Rate[];
      missing: string[];
      errored: Map<string, string>;
    } | null = null;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const shipment = await api<ShippoShipment>("POST", "/shipments", body);
      const rates = (shipment.rates ?? []).map((r) => toRate(r, accounts));
      const quoted = new Set(rates.map((r) => r.carrier));
      const errored = new Map<string, string>();
      for (const m of shipment.messages ?? []) {
        if (m.source && m.text) errored.set(carrierToken(m.source), m.text);
      }
      const missing = [...expected].filter((c) => !quoted.has(c) && !errored.has(c)).sort();
      if (!best || quoted.size > new Set(best.rates.map((r) => r.carrier)).size) {
        best = { shipment, rates, missing, errored };
      }
      const thin = quoted.size === 0 || missing.length > 0;
      if (!thin || attempts > rateDelays.length) break;
      await sleep(rateDelays[attempts - 1] ?? 0);
    }

    return {
      shippoShipmentId: best.shipment.object_id,
      rates: best.rates
        .filter((r) => usable(r.carrier))
        .sort((a, b) => a.amount - b.amount || a.carrier.localeCompare(b.carrier)),
      missingCarriers: best.missing,
      carrierMessages: [...best.errored].map(([carrier, text]) => ({ carrier, text })),
      attempts,
    };
  }

  async function transactionsForRate(rateId: string): Promise<ShippoTransaction[]> {
    const page = await api<{ results?: ShippoTransaction[] }>(
      "GET",
      `/transactions?rate=${encodeURIComponent(rateId)}&results=100`,
    );
    return (page.results ?? []).filter((t) => !t.rate || t.rate === rateId);
  }

  /** Label files are signed storage URLs: fetched WITHOUT the Shippo token. */
  async function downloadLabel(url: string): Promise<string> {
    const res = await doFetch(url, { method: "GET" });
    const body = await res.text();
    if (!res.ok || !body.trim()) {
      throw new ShippoError(res.status, `label download failed (${res.status})`);
    }
    return body;
  }

  /**
   * Buy the label for a rate — one Shippo transaction per parcel — and fetch EVERY parcel's
   * label (a multi-parcel purchase returns the first; the rest are listed by rate). Before
   * buying, existing transactions for the rate are adopted, so a retry after a crash or a
   * partial fetch never pays twice.
   */
  async function buyLabels(input: BuyInput): Promise<{ labels: Label[]; adopted: boolean }> {
    if (input.parcelCount < 1) throw new ShippoError(0, "nothing to buy: no parcels");
    const existing = (await transactionsForRate(input.rateId)).filter((t) => t.status !== "ERROR");
    const adopted = existing.length > 0;
    if (!adopted) {
      const tx = await api<ShippoTransaction>("POST", "/transactions", {
        rate: input.rateId,
        label_file_type: "ZPLII",
        async: false,
        metadata: input.metadata,
      });
      if (tx.status === "ERROR") {
        const why = texts(tx.messages);
        throw new ShippoError(
          402,
          `label purchase refused: ${why.join("; ") || "no reason given"}`,
          why,
        );
      }
    }

    let ready: ShippoTransaction[] = [];
    for (let poll = 0; ; poll += 1) {
      const all = await transactionsForRate(input.rateId);
      ready = all.filter((t) => t.status === "SUCCESS" && t.label_url && t.tracking_number);
      if (ready.length >= input.parcelCount) break;
      // A failed parcel with nothing else still pending can never complete: stop polling.
      const failed = all.find((t) => t.status === "ERROR");
      const live = all.filter((t) => t.status !== "ERROR").length;
      if (failed && live < input.parcelCount) {
        const why = texts(failed.messages);
        throw new ShippoError(
          402,
          `label purchase failed: ${why.join("; ") || "no reason given"}`,
          why,
        );
      }
      if (poll >= labelDelays.length)
        throw new LabelsIncompleteError(ready.length, input.parcelCount);
      await sleep(labelDelays[poll] ?? 0);
    }

    // Parcel order: the shipment lists its parcels; each transaction names its parcel.
    const shipment = await api<ShippoShipment>(
      "GET",
      `/shipments/${encodeURIComponent(input.shippoShipmentId)}`,
    );
    const order = (shipment.parcels ?? []).map((p) => (typeof p === "string" ? p : p.object_id));
    const byCreated = [...ready].sort((a, b) =>
      (a.object_created ?? "").localeCompare(b.object_created ?? ""),
    );
    const indexed = byCreated.map((t, i) => ({
      t,
      index: t.parcel && order.includes(t.parcel) ? order.indexOf(t.parcel) : i,
    }));
    indexed.sort((a, b) => a.index - b.index);

    const labels: Label[] = [];
    for (const [i, { t }] of indexed.slice(0, input.parcelCount).entries()) {
      labels.push({
        parcelIndex: i,
        transactionId: t.object_id,
        trackingNumber: t.tracking_number!,
        labelUrl: t.label_url!,
        zpl: await downloadLabel(t.label_url!),
      });
    }
    return { labels, adopted };
  }

  /** Whether Shippo holds any live (non-ERROR) transaction for the rate — i.e. it was bought. */
  async function hasPurchase(rateId: string): Promise<boolean> {
    return (await transactionsForRate(rateId)).some((t) => t.status !== "ERROR");
  }

  return { carrierAccounts, validateAddress, rateShop, buyLabels, hasPurchase };
}

export type ShippoClient = ReturnType<typeof shippoClient>;

function errorDetail(json: unknown): string {
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    if (typeof o.detail === "string") return o.detail.slice(0, 300);
    const parts = Object.entries(o)
      .filter(([, v]) => Array.isArray(v) || typeof v === "string")
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
    if (parts.length) return parts.join("; ").slice(0, 300);
  }
  return "no detail";
}
