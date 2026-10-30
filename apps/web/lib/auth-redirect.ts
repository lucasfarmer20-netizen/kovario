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
 * The check runs on the normalized result too: dot segments can turn `/a/..//evil` into the
 * protocol-relative `//evil`, which a browser would follow off-site as a Location.
 */
export function safeNextPath(next: string | null, origin: string, fallback: string): string {
  if (!next || !isLocalPath(next)) return fallback;
  // Control characters (tab, newline) are stripped by URL parsing and can hide a `//`.
  if ([...next].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return fallback;
  try {
    const own = new URL(origin).origin;
    const url = new URL(next, origin);
    if (url.origin !== own) return fallback;
    const path = `${url.pathname}${url.search}${url.hash}`;
    // The exact string we return is the Location header; it must resolve back to us.
    return isLocalPath(path) && new URL(path, origin).origin === own ? path : fallback;
  } catch {
    return fallback;
  }
}

/** Starts with one `/` and is not protocol-relative (`//`, `/\`). */
function isLocalPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\");
}
