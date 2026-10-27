"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServer } from "@/lib/supabase/server";

export type SignupState = { error?: string; ok?: string };

const signupSchema = z.object({ email: z.email(), password: z.string().min(8).max(72) });

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
    options: { emailRedirectTo: `${origin}/onboarding` },
  });
  if (error) {
    return {
      error:
        error.code === "user_already_exists"
          ? "That email already has an account; sign in instead."
          : error.code === "weak_password"
            ? "Choose a stronger password."
            : "Could not create the account; try again.",
    };
  }
  // With email confirmation on (production), there is no session until the link is opened.
  if (!data.session) return { ok: "Check your email and open the link to continue." };
  redirect("/onboarding");
}
