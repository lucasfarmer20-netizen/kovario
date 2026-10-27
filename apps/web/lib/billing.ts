import { FunctionsHttpError } from "@supabase/supabase-js";
import type { FilletryClient } from "db";

// Stripe Billing runs in the billing-checkout / billing-portal Edge Functions (secrets and
// the Stripe calls stay there); apps/web only asks them for a redirect URL.

const MESSAGES: Record<string, string> = {
  billing_not_configured: "Billing is not set up on this server yet (Stripe keys are missing).",
  already_subscribed: "You already have a plan; change it under Manage billing.",
  no_customer: "Choose a plan first.",
  price_not_found: "That plan has no Stripe price yet (lookup key filletry-<plan>).",
  forbidden: "Only the owner manages billing.",
  unauthorized: "Your session expired; sign in again.",
  invalid_input: "Unknown plan.",
  stripe_error: "Stripe did not respond; try again in a minute.",
};

export function billingErrorMessage(code: string | undefined): string {
  return (code && MESSAGES[code]) ?? "Billing failed; try again.";
}

/** Calls a billing Edge Function and returns the Stripe URL to send the browser to. */
export async function billingRedirect(
  supabase: FilletryClient,
  fn: "billing-checkout" | "billing-portal",
  body: Record<string, string>,
): Promise<{ url: string } | { error: string }> {
  const { data, error } = await supabase.functions.invoke<{ url?: string }>(fn, { body });
  if (error) {
    const code =
      error instanceof FunctionsHttpError
        ? ((await error.context.json().catch(() => null)) as { error?: string } | null)?.error
        : undefined;
    return { error: billingErrorMessage(code) };
  }
  return data?.url ? { url: data.url } : { error: billingErrorMessage(undefined) };
}
