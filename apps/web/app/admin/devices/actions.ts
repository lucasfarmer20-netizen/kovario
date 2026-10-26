"use server";

import { Constants } from "db";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import QRCode from "qrcode";
import { z } from "zod";
import { adminMutation, unwrap, type ActionState } from "@/lib/admin-action";
import { requireManager } from "@/lib/auth";
import { pairingUrl } from "@/lib/pairing";

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
    { action: "device.create", input: parsed.data },
    async ({ supabase }) => {
      const id = unwrap(
        await supabase.rpc("admin_create_device", {
          p_name: parsed.data.name,
          p_station: parsed.data.station,
          p_site_id: parsed.data.site_id || undefined,
        }),
      );
      return { device_id: id };
    },
    `Added ${parsed.data.name}. Press “Pair” to connect a tablet.`,
  );
  revalidatePath("/admin/devices");
  return result;
}

export type PairingState = {
  error?: string;
  code?: string;
  url?: string;
  qrSvg?: string;
  expiresAt?: string;
};

/**
 * Issues a one-time pairing code. Not routed through withAction: action_log would then
 * store the code, and re-issuing is harmless (it replaces the previous code).
 */
export async function issuePairingCode(deviceId: string): Promise<PairingState> {
  if (!z.uuid().safeParse(deviceId).success) return { error: "Unknown device." };
  try {
    const { supabase } = await requireManager();
    const { data, error } = await supabase.rpc("admin_device_pairing_code", {
      p_device_id: deviceId,
    });
    const row = data?.[0];
    if (error || !row) return { error: error?.message ?? "Could not issue a code." };
    const origin =
      process.env.NEXT_PUBLIC_APP_URL ?? (await headers()).get("origin") ?? "http://localhost:3000";
    const url = pairingUrl(origin, row.code);
    const qrSvg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    revalidatePath("/admin/devices");
    return { code: row.code, url, qrSvg, expiresAt: row.expires_at };
  } catch {
    return { error: "Managers only." };
  }
}
