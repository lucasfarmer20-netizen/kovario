"use server";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { encode, generateRackLocations, nextPalletLocation, type LocationDepth } from "rules";
import { locationTagSheet } from "labels/zpl";
import { enqueuePrintJob } from "db";
import { adminMutation, unwrap, type ActionState } from "@/lib/admin-action";
import type { ManagerSession } from "@/lib/auth";
import { parseRackRows } from "@/lib/locations";

async function orgSlug({ supabase, claims }: ManagerSession): Promise<string> {
  const org = unwrap(await supabase.from("org").select("slug").eq("id", claims.orgId).single());
  if (!org) throw new Error("Organisation unavailable");
  return org.slug;
}

const done = (result: ActionState) => {
  revalidatePath("/admin/locations");
  return result.error ? result : { ...result, nextActionId: randomUUID() };
};

/** Generator: the racking as built → idempotent upsert of every shelf position. */
export async function generateLocations(_: ActionState, form: FormData): Promise<ActionState> {
  return done(
    await adminMutation(
      form,
      async (session, id) => {
        const depths = (["F", "R"] as LocationDepth[]).filter((d) => form.get(`depth_${d}`));
        const rows = generateRackLocations({
          zone: String(form.get("zone") ?? ""),
          rows: parseRackRows(String(form.get("rows") ?? "")),
          depths,
        });
        const slug = await orgSlug(session);
        return unwrap(
          await session.supabase.rpc("admin_locations", {
            p_client_action_id: id,
            p_operation: "generate",
            p_locations: rows.map((l) => ({
              ...l,
              qr: encode("LOC", { orgSlug: slug, code: l.code }),
            })),
          }),
        );
      },
      "Locations generated; existing positions were left as they were.",
    ),
  );
}

/** Next pallet / quarantine location in the zone (`IF-PALLET-nn`). */
export async function addPallet(_: ActionState, form: FormData): Promise<ActionState> {
  return done(
    await adminMutation(
      form,
      async (session, id) => {
        const { supabase } = session;
        const [slug, existing] = await Promise.all([
          orgSlug(session),
          supabase.from("location").select("code").eq("kind", "pallet"),
        ]);
        const pallet = nextPalletLocation(
          String(form.get("zone") ?? ""),
          (unwrap(existing) ?? []).map((l) => l.code),
        );
        return unwrap(
          await supabase.rpc("admin_locations", {
            p_client_action_id: id,
            p_operation: "pallet",
            p_locations: [{ ...pallet, qr: encode("LOC", { orgSlug: slug, code: pallet.code }) }],
          }),
        );
      },
      "Pallet location added.",
    ),
  );
}

export async function setArchived(_: ActionState, form: FormData): Promise<ActionState> {
  const archive = form.get("archive") === "yes";
  let note = "";
  const result = await adminMutation(
    form,
    async ({ supabase }, id) => {
      const r = unwrap(
        await supabase.rpc("admin_locations", {
          p_client_action_id: id,
          p_operation: archive ? "archive" : "unarchive",
          p_location_id: String(form.get("location_id")),
        }),
      ) as { occupied_vessels?: number } | null;
      if (archive && r?.occupied_vessels)
        note = ` ${r.occupied_vessels} basket(s) still sit there; relocate them at Locate.`;
      return r;
    },
    archive ? "Location archived; it can no longer be bound." : "Location restored.",
  );
  return done(result.ok ? { ...result, ok: result.ok + note } : result);
}

/** Tag sheet for the zone's active locations, in walk order. Archived codes never print. */
export async function printLocationTags(_: ActionState, form: FormData): Promise<ActionState> {
  return done(
    await adminMutation(
      form,
      async (session, id) => {
        const { supabase } = session;
        const zone = String(form.get("zone") ?? "");
        const [slug, locations] = await Promise.all([
          orgSlug(session),
          supabase
            .from("location")
            .select("code")
            .eq("zone", zone)
            .eq("is_active", true)
            .order("sort_key"),
        ]);
        const codes = (unwrap(locations) ?? []).map((l) => l.code);
        if (codes.length === 0) throw new Error("No active locations in that zone.");
        return enqueuePrintJob(supabase, id, {
          printerId: String(form.get("printer_id")),
          kind: "location_tag",
          payloadType: "zpl",
          payload: locationTagSheet({ orgSlug: slug, codes }),
        });
      },
      "Location tag sheet queued.",
    ),
  );
}
