"use server";

import { Constants } from "db";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import QRCode from "qrcode";
import { z } from "zod";
import { adminMutation, unwrap, type ActionState } from "@/lib/admin-action";
import { ForbiddenError, requireManager } from "@/lib/auth";
import { requirePlan } from "@/lib/plan";
import { pairingQrText } from "@/lib/pairing";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  station: z.enum(Constants.public.Enums.device_station),
  site_id: z.union([z.uuid(), z.literal("")]),
});

export async function createDevice(_state: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = createSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Enter a name and pick a station." };
  const result = await adminMutation(
    formData,
    async ({ supabase }, id) => {
      await requirePlan("stations", supabase);
      return unwrap(
        await supabase.rpc("admin_create_device", {
          p_client_action_id: id,
          p_name: parsed.data.name,
          p_station: parsed.data.station,
          p_site_id: parsed.data.site_id || undefined,
        }),
      );
    },
    `Added ${parsed.data.name}. Press “Pair” to connect a tablet.`,
  );
  revalidatePath("/admin/devices");
  revalidatePath("/onboarding"); // the onboarding wizard reuses this form
  return result;
}

export type PairingState = {
  error?: string;
  code?: string;
  qrSvg?: string;
  expiresAt?: string;
  /** False when this action id's code has since been replaced, redeemed or expired. */
  active?: boolean;
};

const issueSchema = z.object({ deviceId: z.uuid(), clientActionId: z.uuid() });

/**
 * Issues a one-time pairing code, idempotently per `clientActionId`.
 * admin_device_pairing_code records the action in one transaction and derives the code from
 * the action id, so a replay (double submit, retry after a lost response) returns the same
 * code without the plaintext ever being stored. withAction's action_log shortcut is not
 * used because the stored result deliberately omits the code.
 */
export async function issuePairingCode(
  deviceId: string,
  clientActionId: string,
): Promise<PairingState> {
  if (!issueSchema.safeParse({ deviceId, clientActionId }).success) {
    return { error: "Unknown device." };
  }
  try {
    const { supabase } = await requireManager();
    const { data, error } = await supabase.rpc("admin_device_pairing_code", {
      p_client_action_id: clientActionId,
      p_device_id: deviceId,
    });
    const row = data?.[0];
    if (error || !row) return { error: error?.message ?? "Could not issue a code." };
    revalidatePath("/admin/devices");
    if (!row.active) return { active: false };
    // QR text comes only from the rules codec (FL:PAIR:<code>, hard rule 4).
    const qrSvg = await QRCode.toString(pairingQrText(row.code), {
      type: "svg",
      margin: 1,
      errorCorrectionLevel: "M",
    });
    return { code: row.code, qrSvg, expiresAt: row.expires_at, active: true };
  } catch (err) {
    unstable_rethrow(err); // let the /login redirect through
    if (err instanceof ForbiddenError) return { error: "Managers only." };
    return { error: err instanceof Error ? err.message : "Could not issue a code." };
  }
}
