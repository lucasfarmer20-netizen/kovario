// The Stripe Terminal config form (docs/05-PAYMENTS.md §5): reader id, location, and the Vault
// secret NAMES of the tenant's restricted key and webhook signing secret (DECISION-05). The keys
// themselves are put in Vault by ops (docs/wp/WP-18.md); a pasted key is refused here and again
// by admin_save_stripe_terminal.
import { z } from "zod";

const LOOKS_LIKE_KEY = /^((sk|rk|pk)_(test|live)_|whsec_)/;
const secretName = z
  .string()
  .trim()
  .max(200)
  .refine((v) => !LOOKS_LIKE_KEY.test(v), "Enter the Vault secret's NAME, never the key itself.")
  .refine((v) => v === "" || /^[A-Za-z0-9._:/-]+$/.test(v), "Use letters, digits and . _ : / -");

export const stripeTerminalForm = z.object({
  terminal_id: z.union([z.literal(""), z.uuid()]).optional(),
  name: z.string().trim().min(1, "Name the terminal.").max(80),
  site_id: z.union([z.literal(""), z.uuid()]).optional(),
  reader_id: z
    .string()
    .trim()
    .regex(/^tmr_[A-Za-z0-9]+$/, "The reader id starts with tmr_."),
  location_id: z
    .string()
    .trim()
    .refine((v) => v === "" || /^tml_[A-Za-z0-9]+$/.test(v), "The location id starts with tml_."),
  secret_ref: secretName.refine(
    (v) => v !== "",
    "Name the Vault secret holding the restricted key.",
  ),
  webhook_secret_ref: secretName,
  // A checkbox: present = active.
  is_active: z.literal("on").optional(),
});

export type StripeTerminalForm = z.infer<typeof stripeTerminalForm>;

/** The form's values, or the first problem in plain language. */
export function parseStripeTerminalForm(
  form: Record<string, unknown>,
): { ok: true; value: StripeTerminalForm } | { ok: false; error: string } {
  const parsed = stripeTerminalForm.safeParse({
    location_id: "",
    webhook_secret_ref: "",
    ...form,
  });
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the terminal's fields." };
}

/** Where a tenant points its Stripe webhook for this terminal. */
export function stripeWebhookPath(terminalId: string): string {
  return `/api/payments/stripe/webhook/${terminalId}`;
}
