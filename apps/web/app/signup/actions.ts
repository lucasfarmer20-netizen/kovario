"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { newPasswordSchema, SIGNUP_SENT } from "@/lib/auth-messages";
import { createSupabaseServer } from "@/lib/supabase/server";

export type SignupState = { error?: string; ok?: string };

const signupSchema = z.object({ email: z.email(), password: newPasswordSchema });

/** Step 1 of onboarding: an account. The org is created on /onboarding once signed in. */
export async function signUp(_state: SignupState, formData: FormData): Promise<SignupState> {
  const parsed = signupSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success)
    return { error: "Enter your email and a password of at least 8 characters." };
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? (await headers()).get("origin") ?? "";
  const supabase = await createSupabaseServer();
  const { data, error } = await supabase.auth.signUp({
    ...parsed.data,
    options: { emailRedirectTo: `${origin}/auth/confirm?next=/onboarding` },
  });
  // An existing email gets the same answer as a new one (#116): with confirmation on,
  // Supabase already answers success with no session; with it off it says
  // user_already_exists, which must not reach the form either. The success text links to
  // sign-in and reset for whoever already has an account.
  if (error?.code === "user_already_exists") return { ok: SIGNUP_SENT };
  if (error) {
    return {
      error:
        error.code === "weak_password"
          ? "Choose a stronger password."
          : "Could not create the account; try again.",
    };
  }
  // With email confirmation on (production), there is no session until the link is opened.
  if (!data.session) return { ok: SIGNUP_SENT };
  redirect("/onboarding");
}
