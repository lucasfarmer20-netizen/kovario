"use server";

import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { isPlanCode } from "payments";
import type { ActionState } from "@/lib/admin-action";
import { ForbiddenError, requireManager } from "@/lib/auth";
import { billingRedirect } from "@/lib/billing";

// Opening Checkout or the Portal writes nothing in our database (org.plan changes only via
// the webhook), so these actions need no client_action_id.

async function ownerSession() {
  const session = await requireManager();
  if (session.claims.appRole !== "owner") throw new ForbiddenError();
  return session;
}

async function origin(): Promise<string> {
  return process.env.NEXT_PUBLIC_APP_URL ?? (await headers()).get("origin") ?? "";
}

export async function startCheckout(_state: ActionState, formData: FormData): Promise<ActionState> {
  const plan = formData.get("plan");
  if (!isPlanCode(plan)) return { error: "Pick a plan." };
  const back =
    formData.get("return_to") === "onboarding" ? "/onboarding?step=plan" : "/admin/subscription";
  let target: { url: string } | { error: string };
  try {
    const { supabase } = await ownerSession();
    target = await billingRedirect(supabase, "billing-checkout", {
      plan,
      return_url: `${await origin()}${back}`,
    });
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof ForbiddenError) return { error: "Only the owner manages billing." };
    return { error: "Billing failed; try again." };
  }
  if ("error" in target) return target;
  redirect(target.url);
}

// useActionState passes (state, formData); the portal needs neither.
export async function openPortal(): Promise<ActionState> {
  let target: { url: string } | { error: string };
  try {
    const { supabase } = await ownerSession();
    target = await billingRedirect(supabase, "billing-portal", {
      return_url: `${await origin()}/admin/subscription`,
    });
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof ForbiddenError) return { error: "Only the owner manages billing." };
    return { error: "Billing failed; try again." };
  }
  if ("error" in target) return target;
  redirect(target.url);
}
