"use server";

import { redirect } from "next/navigation";
import { newPasswordSchema, PASSWORD_RULE } from "@/lib/auth-messages";
import { createSupabaseServer } from "@/lib/supabase/server";

export type ResetPasswordState = { error?: string };

/** Sets the new password on the session /auth/confirm opened from the reset link. */
export async function resetPassword(
  _state: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const password = newPasswordSchema.safeParse(formData.get("password"));
  if (!password.success) return { error: PASSWORD_RULE };
  const supabase = await createSupabaseServer();
  const { error } = await supabase.auth.updateUser({ password: password.data });
  if (error) {
    return {
      error:
        error.code === "same_password"
          ? "That is your current password. Choose a different one."
          : error.code === "weak_password"
            ? "Choose a stronger password."
            : error.code === "session_not_found" || error.name === "AuthSessionMissingError"
              ? "This reset link has expired. Ask for a new one."
              : error.code === "reauthentication_needed"
                ? "Open the reset link from your email again, then choose a password."
                : "Could not save the password; try again.",
    };
  }
  redirect("/stations");
}
