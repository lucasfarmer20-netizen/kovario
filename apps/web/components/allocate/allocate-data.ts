"use client";
import { withAction, type Database, type FilletryClient, type Json } from "db";
import type { BoxPlanMethod, SplitMethod } from "rules";
import type { AnglerRow, PooledIntake, SavePayload, SessionDraft } from "./allocate-state";

// Station-side calls for counter allocation. Every mutation is one SQL function keyed by a
// client_action_id (withAction), so a retried request replays instead of writing twice. Money
// is computed only by price_session (app.split_amount, generated from packages/rules).

function unwrap<T>({ data, error }: { data: T; error: { message: string } | null }): T {
  if (error) throw new Error(error.message);
  return data;
}

async function act<T>(
  client: FilletryClient,
  clientActionId: string,
  fn: (id: string) => PromiseLike<{ data: Json; error: { message: string } | null }>,
): Promise<T> {
  const result = await withAction(client, clientActionId, async (id) => unwrap(await fn(id)));
  return result as unknown as T;
}

export type SessionState = Database["public"]["Enums"]["allocation_session_state"];
export type FulfillmentStatus =
  Database["public"]["Enums"]["allocation_session_fulfillment_status"];

export type SessionFilters = {
  state: SessionState | "open" | "";
  fulfillment: FulfillmentStatus | "";
  q: string;
};

/** The session list (allocation_session_list), newest first. `open` = draft + priced. */
export async function listSessions(client: FilletryClient, f: SessionFilters) {
  let query = client
    .from("allocation_session_list")
    .select(
      "session_id, number, state, split_method, party_name, created_at, fulfillment_status, box_count, planned_count, intake_numbers, angler_names, settlement_count, paid_count, amount_total",
    )
    .order("created_at", { ascending: false })
    .limit(200);
  if (f.state === "open") query = query.in("state", ["draft", "priced"]);
  else if (f.state) query = query.eq("state", f.state);
  if (f.fulfillment) query = query.eq("fulfillment_status", f.fulfillment);
  const q = f.q
    .trim()
    .toLowerCase()
    .replace(/[%_\\]/g, "");
  if (q) query = query.like("search_text", `%${q}%`);
  // View columns are nullable in the generated types; the view coalesces them.
  return (unwrap(await query) ?? []).map((r) => ({
    session_id: r.session_id!,
    number: r.number!,
    state: r.state!,
    party_name: r.party_name,
    fulfillment_status: r.fulfillment_status ?? "none",
    box_count: r.box_count ?? 0,
    planned_count: r.planned_count ?? 0,
    intake_numbers: r.intake_numbers ?? [],
    settlement_count: r.settlement_count ?? 0,
    paid_count: r.paid_count ?? 0,
    amount_total: r.amount_total ?? 0,
  }));
}

/** The session a boxing QR (`FL:BOX:<token>`) belongs to, or null. */
export async function sessionForBoxingToken(client: FilletryClient, token: string) {
  const { data, error } = await client
    .from("settlement")
    .select("session_id")
    .eq("boxing_token", token)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.session_id ?? null;
}

const INTAKE_COLUMNS = "id, number, state, customer:customer_id (name)";
type IntakeRow = { id: string; number: string; state: string; customer: { name: string } | null };
const toPooled = (r: IntakeRow): PooledIntake => ({
  id: r.id,
  number: r.number,
  state: r.state,
  customer: r.customer?.name ?? null,
});

/** A customer's intakes that can be pooled (saved, not done or cancelled), newest first. */
export async function customerIntakes(client: FilletryClient, customerId: string) {
  const rows = unwrap(
    await client
      .from("intake")
      .select(INTAKE_COLUMNS)
      .eq("customer_id", customerId)
      .not("state", "in", "(draft,done,cancelled)")
      .order("intake_at", { ascending: false })
      .limit(50),
  );
  return (rows as IntakeRow[]).map(toPooled);
}

/** One intake by number (INT-0042), or null. */
export async function intakeByNumber(client: FilletryClient, number: string) {
  const { data, error } = await client
    .from("intake")
    .select(INTAKE_COLUMNS)
    .eq("number", number)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toPooled(data as IntakeRow) : null;
}

/** Sessions (other than `exceptId`) already pooling each intake: intake_id → ALC numbers. */
export async function otherSessions(
  client: FilletryClient,
  intakeIds: string[],
  exceptId: string | null,
) {
  if (intakeIds.length === 0) return {};
  const rows = unwrap(
    await client
      .from("allocation_intake")
      .select("intake_id, session:session_id (id, number, state)")
      .in("intake_id", intakeIds),
  );
  const out: Record<string, string[]> = {};
  for (const r of rows ?? []) {
    if (!r.session || r.session.id === exceptId || r.session.state === "cancelled") continue;
    (out[r.intake_id] ??= []).push(r.session.number);
  }
  return out;
}

export type Reference = {
  sizes: { id: string; name: string; max_lb: number; fee: number; is_active: boolean }[];
  species: { code: string; name: string }[];
  methods: { code: string; name: string }[];
};

export async function loadReference(client: FilletryClient): Promise<Reference> {
  const [sizes, species, methods] = await Promise.all([
    client.from("box_size").select("id, name, max_lb, fee, is_active").order("max_lb"),
    client.from("species").select("code, name").eq("is_active", true).order("sort"),
    client
      .from("processing_method")
      .select("code, name")
      .eq("is_active", true)
      .eq("kind", "service")
      .order("sort"),
  ]);
  return {
    sizes: unwrap(sizes) ?? [],
    species: unwrap(species) ?? [],
    methods: unwrap(methods) ?? [],
  };
}

/** Species/method lines of the pooled intakes (what the party brought), for the hint panel. */
export async function pooledLines(client: FilletryClient, intakeIds: string[]) {
  if (intakeIds.length === 0) return [];
  return (
    unwrap(
      await client
        .from("intake_line")
        .select("intake_id, species_code, method_code, lb, est_yield_lb")
        .in("intake_id", intakeIds)
        .order("sort"),
    ) ?? []
  );
}

export type SessionSummary = {
  session_id: string;
  number: string;
  state: SessionState;
  split_method: SplitMethod;
  pool: {
    total: number;
    intakes: {
      intake_id: string;
      number: string;
      amount: number;
      billed_here: boolean;
      billed_by: string | null;
    }[];
  };
  settlements: {
    settlement_id: string;
    number: string;
    angler_name: string;
    state: string;
    weight_total_lb: number;
    processing_share: number;
    box_fee_total: number;
    freight_total: number;
    amount_total: number;
  }[];
};

export async function loadSummary(client: FilletryClient, sessionId: string) {
  return unwrap(
    await client.rpc("allocation_session_summary", { p_session_id: sessionId }),
  ) as unknown as SessionSummary;
}

/** The stored session as an editable draft. */
export async function loadDraft(client: FilletryClient, sessionId: string): Promise<SessionDraft> {
  const s = unwrap(
    await client
      .from("allocation_session")
      .select(
        `id, number, state, split_method, notes, party_customer_id, party:party_customer_id (name),
         allocation_intake (intake:intake_id (${INTAKE_COLUMNS})),
         settlement (id, number, angler_name, customer_id, retail_note, state,
           settlement_species (species_code, method_code, lb),
           box_plan (id, number, method, box_size_id, weight_lb, heavy_allowed, fulfillment_state))`,
      )
      .eq("id", sessionId)
      .single(),
  );
  if (!s) throw new Error("allocation session not found");
  const byNumber = (a: { number: string }, b: { number: string }) =>
    a.number.length - b.number.length || a.number.localeCompare(b.number);
  return {
    sessionId: s.id,
    partyCustomerId: s.party_customer_id,
    partyName: s.party?.name ?? null,
    splitMethod: s.split_method,
    notes: s.notes ?? "",
    intakes: s.allocation_intake
      .flatMap((ai) => (ai.intake ? [toPooled(ai.intake as IntakeRow)] : []))
      .sort(byNumber),
    anglers: [...s.settlement].sort(byNumber).map((st): AnglerRow => ({
      key: st.id,
      id: st.id,
      number: st.number,
      angler_name: st.angler_name,
      customer_id: st.customer_id,
      retail_note: st.retail_note ?? "",
      paid: st.state === "paid",
      species: st.settlement_species.map((sp) => ({
        key: crypto.randomUUID(),
        species_code: sp.species_code,
        method_code: sp.method_code,
        lb: String(sp.lb),
      })),
      boxes: [...st.box_plan].sort(byNumber).map((b) => ({
        key: b.id,
        id: b.id,
        number: b.number,
        method: b.method as BoxPlanMethod,
        box_size_id: b.box_size_id ?? "",
        weight: String(b.weight_lb),
        heavy_allowed: b.heavy_allowed,
        fulfillment_state: b.fulfillment_state,
      })),
    })),
  };
}

export function saveSession(client: FilletryClient, clientActionId: string, payload: SavePayload) {
  return act<SessionSummary>(client, clientActionId, (id) =>
    client.rpc("save_allocation_session", {
      p_client_action_id: id,
      p_payload: payload as unknown as Json,
    }),
  );
}

export function priceSession(client: FilletryClient, clientActionId: string, sessionId: string) {
  return act<SessionSummary>(client, clientActionId, (id) =>
    client.rpc("price_session", { p_client_action_id: id, p_session_id: sessionId }),
  );
}

export function cancelSession(client: FilletryClient, sessionId: string, reason: string) {
  return act<SessionSummary>(client, crypto.randomUUID(), (id) =>
    client.rpc("cancel_allocation_session", {
      p_client_action_id: id,
      p_session_id: sessionId,
      p_reason: reason,
    }),
  );
}

export type ReceiptQueued = { print_job_id: string | null; printer_missing: boolean };

export function printSettlementReceipt(client: FilletryClient, settlementId: string) {
  return act<ReceiptQueued>(client, crypto.randomUUID(), (id) =>
    client.rpc("print_settlement_receipt", {
      p_client_action_id: id,
      p_settlement_id: settlementId,
    }),
  );
}

export type SettlementReceipt = {
  settlement_id: string;
  number: string;
  session_id: string;
  session_number: string;
  session_state: SessionState;
  split_method: SplitMethod;
  state: string;
  angler_name: string;
  party_name: string | null;
  date: string;
  weight_total_lb: number;
  processing_share: number;
  box_fee_total: number;
  freight_total: number;
  amount_total: number;
  retail_note: string | null;
  boxing_token: string;
  species: { species: string; method: string; lb: number }[];
  boxes: {
    number: string;
    method: BoxPlanMethod;
    size: string | null;
    weight_lb: number;
    heavy: boolean;
  }[];
};

export async function loadReceipt(client: FilletryClient, settlementId: string) {
  return unwrap(
    await client.rpc("settlement_receipt", { p_settlement_id: settlementId }),
  ) as unknown as SettlementReceipt;
}
