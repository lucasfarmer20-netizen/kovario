"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminMutation, unwrap, type ActionState } from "@/lib/admin-action";
import { ratesFromForm } from "@/lib/rate-card";

const date = z.union([z.literal(""), z.iso.date()]);

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  starts_on: z.iso.date(),
  ends_on: date,
  copy_from: z.union([z.literal(""), z.uuid()]),
});

export async function createRateCard(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = createSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Enter a name and a start date." };
  const { name, starts_on, ends_on, copy_from } = parsed.data;
  const result = await adminMutation(
    formData,
    async ({ supabase }, id) =>
      unwrap(
        await supabase.rpc("admin_create_rate_card", {
          p_client_action_id: id,
          p_name: name,
          p_starts_on: starts_on,
          // null = open-ended; the generated RPC type cannot express a nullable date arg.
          p_ends_on: (ends_on || null) as string,
          p_copy_from: copy_from || undefined,
        }),
      ),
    `Added ${name}. Its rates start as a copy; adjust them below.`,
  );
  revalidatePath("/admin/rate-cards");
  return result;
}

const updateSchema = z.object({
  rate_card_id: z.uuid(),
  name: z.string().trim().min(1).max(80),
  starts_on: date,
  ends_on: date,
});

export async function updateRateCard(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = updateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Enter a name and valid dates." };
  const { rate_card_id, name, starts_on, ends_on } = parsed.data;
  const result = await adminMutation(
    formData,
    async ({ supabase }, id) =>
      unwrap(
        await supabase.rpc("admin_update_rate_card", {
          p_client_action_id: id,
          p_rate_card_id: rate_card_id,
          p_name: name,
          p_starts_on: (starts_on || null) as string,
          p_ends_on: (ends_on || null) as string,
        }),
      ),
    "Saved.",
  );
  revalidatePath("/admin/rate-cards");
  return result;
}

const cardSchema = z.object({ rate_card_id: z.uuid() });

export async function setRateLines(_state: ActionState, formData: FormData): Promise<ActionState> {
  const card = cardSchema.safeParse(Object.fromEntries(formData));
  if (!card.success) return { error: "Unknown rate card." };
  const rates = ratesFromForm(formData);
  if ("error" in rates) return rates;
  const result = await adminMutation(
    formData,
    async ({ supabase }, id) =>
      unwrap(
        await supabase.rpc("admin_set_rate_card_lines", {
          p_client_action_id: id,
          p_rate_card_id: card.data.rate_card_id,
          p_lines: rates.lines,
        }),
      ),
    "Rates saved.",
  );
  revalidatePath("/admin/rate-cards");
  revalidatePath("/onboarding");
  return result;
}

export async function deleteRateCard(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const card = cardSchema.safeParse(Object.fromEntries(formData));
  if (!card.success) return { error: "Unknown rate card." };
  const result = await adminMutation(
    formData,
    async ({ supabase }, id) =>
      unwrap(
        await supabase.rpc("admin_delete_rate_card", {
          p_client_action_id: id,
          p_rate_card_id: card.data.rate_card_id,
        }),
      ),
    "Deleted.",
  );
  revalidatePath("/admin/rate-cards");
  return result;
}
