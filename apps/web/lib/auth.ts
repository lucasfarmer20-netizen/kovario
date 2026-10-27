import { isManager, filletryClaims, type FilletryClaims, type FilletryClient } from "db";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "./supabase/server";

export type StaffSession = {
  supabase: FilletryClient;
  claims: FilletryClaims | null;
  email: string | null;
};

/** The signed-in staff session (verified claims), or a redirect to /login. */
export async function requireStaff(): Promise<StaffSession> {
  const supabase = await createSupabaseServer();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data) redirect("/login");
  const email = typeof data.claims.email === "string" ? data.claims.email : null;
  return { supabase, claims: filletryClaims(data.claims), email };
}

export type ManagerSession = StaffSession & { claims: FilletryClaims };

export class ForbiddenError extends Error {
  constructor() {
    super("Managers only");
    this.name = "ForbiddenError";
  }
}

/** Owner/manager session for an /admin page, or null (the admin layout shows the notice). */
export async function adminPageSession(): Promise<ManagerSession | null> {
  const session = await requireStaff();
  if (!session.claims || !isManager(session.claims)) return null;
  return { ...session, claims: session.claims };
}

/** Owner/manager session for /admin Server Actions; throws ForbiddenError otherwise. */
export async function requireManager(): Promise<ManagerSession> {
  const session = await requireStaff();
  if (!session.claims || !isManager(session.claims)) throw new ForbiddenError();
  return { ...session, claims: session.claims };
}
