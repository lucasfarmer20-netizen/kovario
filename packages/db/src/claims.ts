/** app_role JWT claim values (docs/01-ARCHITECTURE.md §5). */
export const APP_ROLES = ["owner", "manager", "staff", "cashier", "station", "agent"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const MANAGER_ROLES: readonly AppRole[] = ["owner", "manager"];

/** Kovario's custom claims, stamped by app.custom_access_token_hook. */
export type KovarioClaims = {
  userId: string;
  orgId: string;
  appRole: AppRole;
  deviceId: string | null;
};

function isAppRole(value: unknown): value is AppRole {
  return typeof value === "string" && (APP_ROLES as readonly string[]).includes(value);
}

/**
 * Reads Kovario claims from already-verified JWT claims (e.g. `supabase.auth.getClaims()`).
 * Returns null when the session has no org (user without membership, inactive device).
 */
export function kovarioClaims(
  claims: Record<string, unknown> | null | undefined,
): KovarioClaims | null {
  if (!claims) return null;
  const { sub, org_id, app_role, device_id } = claims;
  if (typeof sub !== "string" || typeof org_id !== "string" || !isAppRole(app_role)) return null;
  return {
    userId: sub,
    orgId: org_id,
    appRole: app_role,
    deviceId: typeof device_id === "string" ? device_id : null,
  };
}

export function isManager(claims: KovarioClaims | null): boolean {
  return claims !== null && MANAGER_ROLES.includes(claims.appRole);
}
