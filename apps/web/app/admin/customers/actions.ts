"use server";

import { withAction, type FilletryClient } from "db";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { normalizePhone } from "rules";
import { z } from "zod";
import type {
  CreateCustomerInput,
  CreateCustomerResult,
  CustomerHit,
} from "@/components/customers/customer-search-state";
import { adminMutation, unwrap, type ActionState } from "@/lib/admin-action";
import { ForbiddenError, requireManager } from "@/lib/auth";

const HIT_COLUMNS = "id, name, phone, last_visit_at, is_lodge_guest, lodge_id, lodge(name)";

async function loadHit(supabase: FilletryClient, id: string): Promise<CustomerHit | null> {
  const { data } = await supabase.from("customer").select(HIT_COLUMNS).eq("id", id).maybeSingle();
  if (!data) return null;
  const { lodge, ...rest } = data;
  return { ...rest, lodge_name: lodge?.name ?? null };
}

/** Dropdown search for <CustomerSearch> (public.search_customers). */
export async function searchCustomers(q: string): Promise<CustomerHit[]> {
  const { supabase, claims } = await requireManager();
  const { data, error } = await supabase.rpc("search_customers", {
    p_org_id: claims.orgId,
    p_q: q.slice(0, 100),
  });
  if (error) throw new Error(error.message);
  // Generated RPC types mark every column non-null; phone, last visit and lodge can be null.
  return data as CustomerHit[];
}

const createSchema = z.object({
  clientActionId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(30),
});

/** Inline create from <CustomerSearch>; replays on the same client_action_id. */
export async function createCustomer(input: CreateCustomerInput): Promise<CreateCustomerResult> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { error: "Enter the customer's name." };
  const phone = parsed.data.phone ? normalizePhone(parsed.data.phone) : "";
  if (phone === null) return { error: "Enter a full phone number, e.g. (907) 555-1234." };
  try {
    const { supabase } = await requireManager();
    const result = await withAction(supabase, parsed.data.clientActionId, async (id) =>
      unwrap(
        await supabase.rpc("create_customer", {
          p_client_action_id: id,
          p_name: parsed.data.name,
          p_phone: phone,
        }),
      ),
    );
    const customerId = (result as { customer_id?: string } | null)?.customer_id;
    const customer = customerId ? await loadHit(supabase, customerId) : null;
    if (!customer) return { error: "Customer created but could not be loaded; search again." };
    revalidatePath("/admin/customers");
    return { customer };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof ForbiddenError) return { error: "Managers only." };
    return { error: err instanceof Error ? err.message : "Something went wrong." };
  }
}

const updateSchema = z.object({
  customer_id: z.uuid(),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(30),
  email: z.union([z.email(), z.literal("")]),
  notes: z.string().max(2000),
});

export async function updateCustomer(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = updateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Check the name and email." };
  const phone = parsed.data.phone ? normalizePhone(parsed.data.phone) : "";
  if (phone === null) return { error: "Enter a full phone number, e.g. (907) 555-1234." };
  const result = await adminMutation(
    formData,
    async ({ supabase }, id) =>
      unwrap(
        await supabase.rpc("admin_update_customer", {
          p_client_action_id: id,
          p_customer_id: parsed.data.customer_id,
          p_name: parsed.data.name,
          p_phone: phone,
          p_email: parsed.data.email,
          p_notes: parsed.data.notes,
        }),
      ),
    "Saved.",
  );
  revalidatePath(`/admin/customers/${parsed.data.customer_id}`);
  return result;
}

// `lodge` is "none" (not a lodge guest) or the lodge id the customer is a guest of.
const lodgeSchema = z.object({
  customer_id: z.uuid(),
  lodge: z.union([z.literal("none"), z.uuid()]),
});

/** The lodge-guest flip: set_lodge_guest writes the reprice event (docs/04 §2). */
export async function setLodgeGuest(_state: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = lodgeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Pick a lodge or “Not a lodge guest”." };
  const guest = parsed.data.lodge !== "none";
  const result = await adminMutation(
    formData,
    async ({ supabase }, id) =>
      unwrap(
        await supabase.rpc("set_lodge_guest", {
          p_client_action_id: id,
          p_customer_id: parsed.data.customer_id,
          p_is_lodge_guest: guest,
          p_lodge_id: guest ? parsed.data.lodge : undefined,
        }),
      ),
    guest
      ? "Marked as a lodge guest. Open unpaid charges will be repriced."
      : "No longer a lodge guest. Open unpaid charges will be repriced.",
  );
  revalidatePath(`/admin/customers/${parsed.data.customer_id}`);
  return result;
}

const mergeSchema = z.object({ keep_id: z.uuid(), merge_id: z.uuid() });

export async function mergeCustomers(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = mergeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Pick the customer to keep and the one to merge." };
  if (parsed.data.keep_id === parsed.data.merge_id) {
    return { error: "Pick two different customers." };
  }
  const result = await adminMutation(
    formData,
    async ({ supabase }, id) =>
      unwrap(
        await supabase.rpc("admin_merge_customers", {
          p_client_action_id: id,
          p_keep_id: parsed.data.keep_id,
          p_merge_id: parsed.data.merge_id,
        }),
      ),
    "Merged.",
  );
  revalidatePath("/admin/customers");
  revalidatePath(`/admin/customers/${parsed.data.keep_id}`);
  return result;
}
