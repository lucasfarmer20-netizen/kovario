import { z } from "zod";

// Sign-in, signup and password reset wording (#116). None of these may tell a stranger
// whether an email has an account: the same text shows whether it does or not.

/** Same rule on /signup and /reset-password (bcrypt reads at most 72 bytes). */
export const newPasswordSchema = z.string().min(8).max(72);
export const PASSWORD_RULE = "Enter a password of 8 to 72 characters.";

/** /signup success, whether or not the email already had an account. */
export const SIGNUP_SENT = "Check your email and open the link to continue.";

/** /forgot-password response, whatever the email and whatever Supabase answered. */
export const RESET_SENT = "If that email has an account, a reset link is on its way.";

/** Codes /login turns into a message (never free text from the URL). */
export const LOGIN_NOTICES = {
  link: "That link is invalid or has expired. Sign in, or ask for a new link.",
} as const;
export type LoginNotice = keyof typeof LOGIN_NOTICES;

export function loginNotice(code: string | string[] | undefined): string | null {
  return typeof code === "string" && code in LOGIN_NOTICES
    ? LOGIN_NOTICES[code as LoginNotice]
    : null;
}
