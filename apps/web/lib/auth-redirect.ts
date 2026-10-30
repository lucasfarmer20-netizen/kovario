import type { EmailOtpType } from "@supabase/supabase-js";

/** Email link types /auth/confirm accepts (signup confirmation, reset, invite, email change). */
export const EMAIL_LINK_TYPES = ["signup", "recovery", "invite", "email_change", "email"] as const;
export type EmailLinkType = (typeof EMAIL_LINK_TYPES)[number] & EmailOtpType;

/** Where each kind of email link lands when it has no usable `next`. */
const DEFAULT_NEXT: Record<EmailLinkType, string> = {
  signup: "/onboarding",
  email: "/onboarding",
  recovery: "/reset-password",
  invite: "/auth/accept",
  email_change: "/stations",
};

export function emailLinkType(value: string | null): EmailLinkType | null {
  return (EMAIL_LINK_TYPES as readonly string[]).includes(value ?? "")
    ? (value as EmailLinkType)
    : null;
}

export function defaultNext(type: EmailLinkType | null): string {
  return type ? DEFAULT_NEXT[type] : "/stations";
}

/**
 * `next` as a same-origin path (path + query + hash), or `fallback`. Absolute URLs,
 * protocol-relative (`//evil`), backslash tricks (`/\evil`) and anything that resolves to
 * another origin are refused, so an email link can never bounce a session off-site.
 */
export function safeNextPath(next: string | null, origin: string, fallback: string): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return fallback;
  }
  // Control characters (tab, newline) are stripped by URL parsing and can hide a `//`.
  if ([...next].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return fallback;
  try {
    const url = new URL(next, origin);
    if (url.origin !== new URL(origin).origin) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
