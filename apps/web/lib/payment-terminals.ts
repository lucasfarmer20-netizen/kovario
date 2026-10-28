// The Stripe Terminal config form (docs/05-PAYMENTS.md §5): reader id, location, and the Vault
// secret NAMES of the tenant's restricted key and webhook signing secret (DECISION-05). The keys
// themselves are put in Vault by ops (docs/wp/WP-18.md); a pasted key is refused here and again
// by admin_save_stripe_terminal. Vault is global, so names are scoped to the org with WP-17's
// convention `terminal:<org id>:<name>`: the owner types `<name>`, the server adds the prefix, and
// the database refuses any other org's name on save and on every resolution.
import { z } from "zod";

const LOOKS_LIKE_KEY = /^((sk|rk|pk)_(test|live)_|whsec_)/i;

/** `<name>` of `terminal:<org id>:<name>`, as WP-17's Dejavoo form takes it. */
const secretName = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => !LOOKS_LIKE_KEY.test(v), "Enter the Vault secret's NAME, never the key itself.")
  .refine(
    (v) => v === "" || /^[a-z0-9][a-z0-9_-]{0,59}$/.test(v),
    "A secret name is lowercase letters, digits, - or _ (at most 60).",
  );

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
  secret_name: secretName.refine(
    (v) => v !== "",
    "Name the Vault secret holding the restricted key.",
  ),
  webhook_secret_name: secretName,
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
    webhook_secret_name: "",
    ...form,
  });
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the terminal's fields." };
}

/** The Vault name prefix of an org's terminal secrets (WP-17's convention). */
export function terminalSecretPrefix(orgId: string): string {
  return `terminal:${orgId}:`;
}

/** The full Vault name for `name` ("" stays ""). */
export function terminalSecretRef(orgId: string, name: string): string {
  return name === "" ? "" : `${terminalSecretPrefix(orgId)}${name}`;
}

/** What the form shows for a stored name: the part after the org's own prefix, else nothing. */
export function secretNameField(orgId: string, stored: string | null | undefined): string {
  const prefix = terminalSecretPrefix(orgId);
  return stored?.startsWith(prefix) ? stored.slice(prefix.length) : "";
}

/** Where a tenant points its Stripe webhook for this terminal. */
export function stripeWebhookPath(terminalId: string): string {
  return `/api/payments/stripe/webhook/${terminalId}`;
}
