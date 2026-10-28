"use client";
import { withAction, type Database, type FilletryClient, type Json } from "db";
import { normalizePhone, type IntakePricing, type SaveIntakePayload } from "rules";
import type {
  CreateCustomerInput,
  CreateCustomerResult,
  CustomerHit,
} from "@/components/customers/customer-search-state";
import type { OrgReference } from "./intake-form-state";

// Station-side calls for the intake desk. Every mutation is one SQL function keyed by a
// client_action_id (withAction), so a retried request replays instead of writing twice.

function unwrap<T>({ data, error }: { data: T; error: { message: string } | null }): T {
  if (error) throw new Error(error.message);
  return data;
}

const HIT_COLUMNS = "id, name, phone, last_visit_at, is_lodge_guest, lodge_id, lodge(name)";

async function loadHit(client: FilletryClient, id: string): Promise<CustomerHit | null> {
  const { data } = await client.from("customer").select(HIT_COLUMNS).eq("id", id).maybeSingle();
  if (!data) return null;
  const { lodge, ...rest } = data;
  return { ...rest, lodge_name: lodge?.name ?? null };
}

export async function searchCustomers(
  client: FilletryClient,
  orgId: string,
  q: string,
): Promise<CustomerHit[]> {
  const data = unwrap(
    await client.rpc("search_customers", { p_org_id: orgId, p_q: q.slice(0, 100) }),
  );
  // Generated RPC types mark every column non-null; phone, last visit and lodge can be null.
  return data as CustomerHit[];
}

export async function createCustomer(
  client: FilletryClient,
  input: CreateCustomerInput,
): Promise<CreateCustomerResult> {
  const name = input.name.trim();
  if (!name) return { error: "Enter the customer's name." };
  const phone = input.phone.trim() ? normalizePhone(input.phone) : "";
  if (phone === null) return { error: "Enter a full phone number, e.g. (907) 555-1234." };
  try {
    const result = await withAction(client, input.clientActionId, async (id) =>
      unwrap(
        await client.rpc("create_customer", {
          p_client_action_id: id,
          p_name: name,
          p_phone: phone,
        }),
      ),
    );
    const customerId = (result as { customer_id?: string } | null)?.customer_id;
    const customer = customerId ? await loadHit(client, customerId) : null;
    return customer
      ? { customer }
      : { error: "Customer created but could not be loaded; search again." };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Something went wrong." };
  }
}

export async function loadCustomer(client: FilletryClient, id: string) {
  return loadHit(client, id);
}

export async function loadReference(client: FilletryClient): Promise<OrgReference> {
  const cols = "code, name, sort, is_active";
  const [species, conditions, methods] = await Promise.all([
    client.from("species").select(cols),
    client.from("incoming_condition").select(cols),
    client.from("processing_method").select(cols),
  ]);
  return {
    species: unwrap(species) ?? [],
    conditions: unwrap(conditions) ?? [],
    methods: unwrap(methods) ?? [],
  };
}

export type PriceContext = {
  rate_card: { id: string; name: string } | null;
  rates: Record<string, number>;
  lodge_cappable: Record<string, boolean>;
  customer: {
    id: string;
    is_lodge_guest: boolean;
    lodge_name: string | null;
    lodge_cap: number | null;
  } | null;
};

export async function loadPriceContext(
  client: FilletryClient,
  customerId: string | null,
  intakeId: string | null,
): Promise<PriceContext> {
  const data = unwrap(
    await client.rpc("intake_price_context", {
      p_customer_id: customerId ?? undefined,
      p_intake_id: intakeId ?? undefined,
    }),
  );
  return data as unknown as PriceContext;
}

export function pricingFrom(ctx: PriceContext, fastPass: boolean): IntakePricing {
  return {
    rates: ctx.rates,
    fastPass,
    isLodgeGuest: ctx.customer?.is_lodge_guest ?? false,
    lodgeCap: ctx.customer?.lodge_cap ?? null,
    lodgeCappable: ctx.lodge_cappable,
  };
}

export type SaveResult = {
  intake_id: string;
  number: string;
  tote_jobs_queued: number;
  receipt_job_id: string | null;
  printer_missing: boolean;
};

export async function saveIntake(
  client: FilletryClient,
  clientActionId: string,
  payload: SaveIntakePayload,
): Promise<SaveResult> {
  const result = await withAction(client, clientActionId, async (id) =>
    unwrap(
      await client.rpc("save_intake", {
        p_client_action_id: id,
        p_payload: payload as unknown as Json,
      }),
    ),
  );
  return result as unknown as SaveResult;
}

export async function unlockIntake(
  client: FilletryClient,
  intakeId: string,
  elevationToken: string,
): Promise<void> {
  const id = crypto.randomUUID();
  await withAction(client, id, async (actionId) =>
    unwrap(
      await client.rpc("unlock_intake", {
        p_client_action_id: actionId,
        p_intake_id: intakeId,
        p_elevation_token: elevationToken,
      }),
    ),
  );
}

export async function reprintToteTags(client: FilletryClient, intakeId: string) {
  const id = crypto.randomUUID();
  const result = await withAction(client, id, async (actionId) =>
    unwrap(
      await client.rpc("reprint_intake_tote_tags", {
        p_client_action_id: actionId,
        p_intake_id: intakeId,
      }),
    ),
  );
  return result as { tote_jobs_queued: number; printer_missing: boolean };
}

export async function printReceipt(client: FilletryClient, intakeId: string) {
  const id = crypto.randomUUID();
  const result = await withAction(client, id, async (actionId) =>
    unwrap(
      await client.rpc("print_intake_receipt", {
        p_client_action_id: actionId,
        p_intake_id: intakeId,
      }),
    ),
  );
  return result as { printer_missing: boolean };
}

// One literal so supabase-js can type the selection.
const INTAKE_COLUMNS =
  "id, number, state, locked, customer_id, intake_at, estimated_pickup_at, hold_until, pulled_at, rollstock_at, rollstock_done_at, reconcile_at, blast_at, stored_at, done_at, cancelled_at, tote_count, dirty_fish, dirty_notes, cut_notes, processing_notes, fast_pass, is_lodge_guest, ribbing, total_incoming_lb, total_est_yield_lb, customer(name, phone)";

export async function loadIntake(client: FilletryClient, id: string) {
  const [intake, lines, charges, totes] = await Promise.all([
    client.from("intake").select(INTAKE_COLUMNS).eq("id", id).maybeSingle(),
    client
      .from("intake_line")
      .select(
        "id, sort, species_code, condition_code, method_code, lb, fillets_pct, skin_off, yield_factor, est_yield_lb, notes",
      )
      .eq("intake_id", id)
      .order("sort"),
    client
      .from("charge")
      .select("id, number, kind, description, qty, unit_price, amount, state")
      .eq("source_type", "intake")
      .eq("source_id", id)
      .neq("state", "voided")
      .order("number"),
    client
      .from("tote_tag")
      .select("tote_no, of_count, qr, print_job_id")
      .eq("intake_id", id)
      .order("tote_no"),
  ]);
  return {
    intake: unwrap(intake),
    lines: unwrap(lines) ?? [],
    charges: unwrap(charges) ?? [],
    totes: unwrap(totes) ?? [],
  };
}

export type LoadedIntake = Awaited<ReturnType<typeof loadIntake>>;

export type IntakeState = Database["public"]["Enums"]["intake_state"];

export async function listIntakes(client: FilletryClient, state: IntakeState | null) {
  let q = client
    .from("intake")
    .select(
      "id, number, state, intake_at, tote_count, total_incoming_lb, fast_pass, dirty_fish, ribbing, customer(name)",
    )
    .order("intake_at", { ascending: false })
    .limit(200);
  if (state) q = q.eq("state", state);
  return unwrap(await q) ?? [];
}
