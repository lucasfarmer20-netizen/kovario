"use server";

import { FunctionsHttpError } from "@supabase/supabase-js";
import { Constants } from "db";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { adminMutation, unwrap, type ActionState } from "@/lib/admin-action";

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
    { action: "member.invite", input: { email: parsed.data.email, role: parsed.data.role } },
    async ({ supabase }) => {
      const { data, error } = await supabase.functions.invoke<{
        member_id: string;
        invited: boolean;
      }>("member-invite", { body: { ...parsed.data, redirect_to: `${origin}/auth/accept` } });
      if (error) {
        const detail =
          error instanceof FunctionsHttpError
            ? ((await error.context.json().catch(() => null)) as { error?: string } | null)?.error
            : undefined;
        throw new Error(detail ?? "Invite failed.");
      }
      return { member_id: data?.member_id ?? null, invited: data?.invited ?? false };
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
    { action: "member.set_role", input: parsed.data },
    async ({ supabase }) => {
      unwrap(
        await supabase.rpc("admin_set_member_role", {
          p_member_id: parsed.data.member_id,
          p_role: parsed.data.role,
        }),
      );
      return parsed.data;
    },
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
    // The PIN itself is never written to action_log.
    { action: "member.set_pin", input: { member_id: parsed.data.member_id } },
    async ({ supabase }) => {
      unwrap(
        await supabase.rpc("admin_set_member_pin", {
          p_member_id: parsed.data.member_id,
          p_pin: parsed.data.pin,
        }),
      );
      return { member_id: parsed.data.member_id };
    },
    "PIN set.",
  );
  revalidatePath("/admin/users");
  return result;
}
