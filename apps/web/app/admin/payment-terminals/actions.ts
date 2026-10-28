"use server";

import { revalidatePath } from "next/cache";
import { normalizeSpinEndpoint } from "payments";
import { z } from "zod";
import { adminMutation, unwrap, type ActionState } from "@/lib/admin-action";
import { parseStripeTerminalForm, terminalSecretRef } from "@/lib/payment-terminals";

const terminalSchema = z.object({
  terminal_id: z.union([z.literal(""), z.uuid()]).optional(),
  name: z.string().trim().min(1).max(80),
  endpoint: z.string().trim().min(1).max(200),
  tpn: z.string().trim().min(1).max(32),
  register_id: z.string().trim().max(40),
  timeout_secs: z.union([z.literal(""), z.coerce.number().int().min(30).max(180)]),
  // the Vault secret is named terminal:<org id>:<secret_name>
  secret_name: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9_-]{0,59}$/),
  site_id: z.union([z.literal(""), z.uuid()]).optional(),
  // A checkbox: present = active.
  is_active: z.literal("on").optional(),
});

/** Adds (no id) or edits a Dejavoo SPIn terminal (docs/05 §4). Owners only (checked in SQL). */
export async function savePaymentTerminal(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = terminalSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return {
      error:
        "Enter a name, endpoint host, TPN, a timeout of 30–180 s (or blank) and a secret name (lowercase letters, digits, - or _).",
    };
  }
  const d = parsed.data;
  const endpoint = normalizeSpinEndpoint(d.endpoint);
  if (!endpoint) return { error: "Endpoint host must be a host name, e.g. spinpos.net." };
  const result = await adminMutation(
    formData,
    async ({ supabase, claims }, id) =>
      unwrap(
        await supabase.rpc("admin_save_payment_terminal", {
          p_client_action_id: id,
          // null creates; the generated RPC type cannot express a nullable uuid arg.
          p_terminal_id: (d.terminal_id || null) as string,
          p_name: d.name,
          p_endpoint_url: endpoint,
          p_tpn: d.tpn,
          p_secret_ref: `terminal:${claims.orgId}:${d.secret_name}`,
          p_register_id: d.register_id || undefined,
          p_timeout_secs: d.timeout_secs === "" ? undefined : d.timeout_secs,
          p_site_id: d.site_id || undefined,
          p_is_active: d.is_active === "on",
        }),
      ),
    d.terminal_id ? "Saved." : `Added ${d.name}.`,
  );
  revalidatePath("/admin/payment-terminals");
  return result;
}

/** Adds a Stripe Terminal reader (no id) or edits one (docs/05 §5). Owners only (checked in SQL). */
export async function saveStripeTerminal(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = parseStripeTerminalForm(Object.fromEntries(formData));
  if (!parsed.ok) return { error: parsed.error };
  const d = parsed.value;
  const result = await adminMutation(
    formData,
    async ({ supabase, claims }, id) =>
      unwrap(
        await supabase.rpc("admin_save_stripe_terminal", {
          p_client_action_id: id,
          // null creates; the generated RPC type cannot express a nullable uuid arg.
          p_terminal_id: (d.terminal_id || null) as string,
          p_name: d.name,
          p_reader_id: d.reader_id,
          // Vault names are scoped to the org (terminal:<org id>:<name>); the DB enforces it too.
          p_secret_ref: terminalSecretRef(claims.orgId, d.secret_name),
          p_location_id: d.location_id || undefined,
          p_webhook_secret_ref: terminalSecretRef(claims.orgId, d.webhook_secret_name) || undefined,
          p_site_id: d.site_id || undefined,
          p_is_active: d.is_active === "on",
        }),
      ),
    d.terminal_id ? "Saved." : `Added ${d.name}.`,
  );
  revalidatePath("/admin/payment-terminals");
  return result;
}
