// Pure helpers for the counter allocation station (docs/06-STATIONS-UX.md Counter allocation).
// The split, heavy check and settlement totals come from packages/rules allocation.ts; money
// is stored only by price_session — the panel here is a preview of the same rule.
import {
  boxPlanIssues,
  priceSettlements,
  type BoxPlanMethod,
  type SettlementPrice,
  type SplitMethod,
} from "rules";

export type PooledIntake = { id: string; number: string; state: string; customer: string | null };

export type SpeciesRow = { key: string; species_code: string; method_code: string; lb: string };

export type BoxRow = {
  key: string;
  id: string | null;
  number: string | null;
  method: BoxPlanMethod;
  box_size_id: string;
  weight: string;
  heavy_allowed: boolean;
  /** `planned` boxes are editable; released ones are facts the crew reported. */
  fulfillment_state: string;
};

export type AnglerRow = {
  key: string;
  id: string | null;
  number: string | null;
  angler_name: string;
  customer_id: string | null;
  retail_note: string;
  paid: boolean;
  species: SpeciesRow[];
  boxes: BoxRow[];
};

export type SessionDraft = {
  sessionId: string | null;
  partyCustomerId: string | null;
  partyName: string | null;
  splitMethod: SplitMethod;
  notes: string;
  intakes: PooledIntake[];
  anglers: AnglerRow[];
};

export type SavePayload = {
  session_id: string | null;
  party_customer_id: string | null;
  split_method: SplitMethod;
  notes: string | null;
  intake_ids: string[];
  settlements: {
    id: string | null;
    angler_name: string;
    customer_id: string | null;
    retail_note: string | null;
    species: { species_code: string; method_code: string; lb: number }[];
    boxes: {
      id: string | null;
      method: BoxPlanMethod;
      box_size_id: string;
      weight_lb: number;
      heavy_allowed: boolean;
    }[];
  }[];
};

export const SESSION_STATE_LABELS: Record<string, string> = {
  draft: "Draft",
  priced: "Priced",
  done: "Done",
  cancelled: "Cancelled",
};

export const FULFILLMENT_LABELS: Record<string, string> = {
  none: "No boxes",
  pending: "Not released",
  partial: "Partly released",
  released: "Released",
};

export const BOX_METHOD_LABELS: Record<BoxPlanMethod, string> = {
  air: "Air (checked)",
  ship: "Ship",
  willcall: "Will-call",
};

const key = () => crypto.randomUUID();

export function emptySpecies(species_code = "", method_code = ""): SpeciesRow {
  return { key: key(), species_code, method_code, lb: "" };
}

export function emptyBox(box_size_id = ""): BoxRow {
  return {
    key: key(),
    id: null,
    number: null,
    method: "willcall",
    box_size_id,
    weight: "",
    heavy_allowed: false,
    fulfillment_state: "planned",
  };
}

export function emptyAngler(name = ""): AnglerRow {
  return {
    key: key(),
    id: null,
    number: null,
    angler_name: name,
    customer_id: null,
    retail_note: "",
    paid: false,
    species: [emptySpecies()],
    boxes: [],
  };
}

export function newDraft(intakes: PooledIntake[], party: { id: string; name: string } | null) {
  return {
    sessionId: null,
    partyCustomerId: party?.id ?? null,
    partyName: party?.name ?? null,
    splitMethod: "weight",
    notes: "",
    intakes,
    anglers: [emptyAngler(party?.name ?? "")],
  } satisfies SessionDraft;
}

/** `raw` as lb / dollars with at most 2 decimals, or null. */
export function parseAmount(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+(\.\d{1,2})?$|^\.\d{1,2}$/.test(t)) return null;
  return Number(t);
}

/** Σ take-home lb of an angler (blank / invalid rows count as 0). */
export function anglerLb(angler: AnglerRow): number {
  return Math.round(angler.species.reduce((c, s) => c + (parseAmount(s.lb) ?? 0) * 100, 0)) / 100;
}

/** The draft as the save_allocation_session payload, or the problems to fix first. */
export function savePayload(draft: SessionDraft): { payload: SavePayload } | { errors: string[] } {
  const errors: string[] = [];
  if (draft.intakes.length === 0) errors.push("Add at least one intake to the session.");
  const settlements = draft.anglers.map((a, ai) => {
    const who = a.angler_name.trim() || `Angler ${ai + 1}`;
    if (!a.angler_name.trim()) errors.push(`${who}: enter the angler's name.`);
    const seen = new Set<string>();
    const species = a.species
      .filter((s) => s.species_code || s.method_code || s.lb.trim())
      .map((s) => {
        const lb = parseAmount(s.lb);
        if (!s.species_code || !s.method_code) errors.push(`${who}: pick species and method.`);
        if (lb === null) errors.push(`${who}: lb must be a number (up to 2 decimals).`);
        const pair = `${s.species_code}/${s.method_code}`;
        if (seen.has(pair)) errors.push(`${who}: a species and method is listed twice.`);
        seen.add(pair);
        return { species_code: s.species_code, method_code: s.method_code, lb: lb ?? 0 };
      });
    const boxes = a.boxes.map((b, bi) => {
      const label = `${who} box ${b.number ?? bi + 1}`;
      const weight = parseAmount(b.weight);
      if (!b.box_size_id) errors.push(`${label}: pick a size.`);
      if (weight === null) errors.push(`${label}: weight must be a number of lb.`);
      else if (boxPlanIssues({ weightLb: weight, heavyAllowed: b.heavy_allowed }).length > 0)
        errors.push(`${label}: over 70 lb — tick Heavy OK to confirm.`);
      return {
        id: b.id,
        method: b.method,
        box_size_id: b.box_size_id,
        weight_lb: weight ?? 0,
        heavy_allowed: b.heavy_allowed,
      };
    });
    return {
      id: a.id,
      angler_name: a.angler_name.trim(),
      customer_id: a.customer_id,
      retail_note: a.retail_note.trim() || null,
      species,
      boxes,
    };
  });
  if (errors.length > 0) return { errors: [...new Set(errors)] };
  return {
    payload: {
      session_id: draft.sessionId,
      party_customer_id: draft.partyCustomerId,
      split_method: draft.splitMethod,
      notes: draft.notes.trim() || null,
      intake_ids: draft.intakes.map((i) => i.id),
      settlements,
    },
  };
}

/**
 * Live preview of what Price will store (the same rule, packages/rules priceSettlements), or
 * a reason it cannot price yet. `fees` maps box_size_id → catalogue fee.
 */
export function previewSettlements(
  draft: SessionDraft,
  pooledProcessing: number,
  fees: Record<string, number>,
  freight: (angler: AnglerRow) => number = () => 0,
): { settlements: SettlementPrice[] } | { reason: string } {
  if (draft.anglers.length === 0) return { reason: "Add an angler." };
  try {
    return {
      settlements: priceSettlements({
        pooledProcessing,
        method: draft.splitMethod,
        anglers: draft.anglers.map((a) => ({
          speciesLb: [anglerLb(a)],
          boxFees: a.boxes.map((b) => fees[b.box_size_id] ?? 0),
          freight: freight(a),
        })),
      }),
    };
  } catch (err) {
    return { reason: err instanceof Error ? err.message : "Cannot price yet." };
  }
}

export const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
