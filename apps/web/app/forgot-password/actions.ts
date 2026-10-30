"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { RESET_SENT } from "@/lib/auth-messages";
import { createSupabaseServer } from "@/lib/supabase/server";

export type ForgotPasswordState = { error?: string; ok?: string };

/**
 * Sends a reset link. The answer is the same whatever happens (#116): Supabase's own errors
 * (resend throttle, rate limit) only occur for an address that has an account, so passing
 * them on would tell a stranger which emails are registered.
 */
export async function requestPasswordReset(
  _state: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  const email = z.email().safeParse(formData.get("email"));
  if (!email.success) return { error: "Enter your email." };
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? (await headers()).get("origin") ?? "";
  const supabase = await createSupabaseServer();
  await supabase.auth.resetPasswordForEmail(email.data, {
    redirectTo: `${origin}/auth/confirm?next=/reset-password`,
  });
  return { ok: RESET_SENT };
}
