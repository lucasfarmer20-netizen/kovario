"use server";

import { FunctionsHttpError } from "@supabase/supabase-js";
import { Constants, type Json } from "db";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { adminMutation, unwrap, type ActionState } from "@/lib/admin-action";
import { requirePlan } from "@/lib/plan";

const role = z.enum(Constants.public.Enums.org_member_role);

const inviteSchema = z.object({
  email: z.email(),
  display_name: z.string().trim().min(1).max(80),
  role,
});

export async function inviteMember(_state: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = inviteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Enter an email, a name and a role." };
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? (await headers()).get("origin") ?? "";
  const result = await adminMutation(
    formData,
    async ({ supabase }, id) => {
      await requirePlan("users", supabase);
      // member-invite records the membership with this id (admin_add_member), so a retry
      // after a lost response replays instead of adding the member twice. The invite
      // template links to /auth/confirm (#116); redirect_to only serves Supabase's default
      // link, which carries the session in the URL fragment that /auth/accept reads.
      const { data, error } = await supabase.functions.invoke<Json>("member-invite", {
        body: { ...parsed.data, client_action_id: id, redirect_to: `${origin}/auth/accept` },
      });
      if (error) {
        const detail =
          error instanceof FunctionsHttpError
            ? ((await error.context.json().catch(() => null)) as { error?: string } | null)?.error
            : undefined;
        throw new Error(detail ?? "Invite failed.");
      }
      return data;
    },
    `Invited ${parsed.data.email}.`,
  );
  revalidatePath("/admin/users");
  return result;
}

const roleSchema = z.object({ member_id: z.uuid(), role });

export async function setMemberRole(_state: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = roleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Pick a role." };
  const result = await adminMutation(
    formData,
    async ({ supabase }, id) =>
      unwrap(
        await supabase.rpc("admin_set_member_role", {
          p_client_action_id: id,
          p_member_id: parsed.data.member_id,
          p_role: parsed.data.role,
        }),
      ),
    "Role saved.",
  );
  revalidatePath("/admin/users");
  return result;
}

const pinSchema = z.object({
  member_id: z.uuid(),
  pin: z.string().regex(/^\d{4,6}$/, "PIN must be 4–6 digits"),
});

export async function setMemberPin(_state: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = pinSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "PIN must be 4–6 digits." };
  const result = await adminMutation(
    formData,
    // admin_set_member_pin never writes the PIN to action_log.
    async ({ supabase }, id) =>
      unwrap(
        await supabase.rpc("admin_set_member_pin", {
          p_client_action_id: id,
          p_member_id: parsed.data.member_id,
          p_pin: parsed.data.pin,
        }),
      ),
    "PIN set.",
  );
  revalidatePath("/admin/users");
  return result;
}
