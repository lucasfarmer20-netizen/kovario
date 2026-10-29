"use server";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { encode, normalizeTagCode } from "rules";
import { assetTagSheet } from "labels/zpl";
import { enqueuePrintJob } from "db";
import { adminMutation, unwrap, type ActionState } from "@/lib/admin-action";
import { tagRangeProblem } from "@/lib/asset-tags";
import type { ManagerSession } from "@/lib/auth";
import type { OrgSettings } from "@/lib/org-settings";

/** Slug and tag width (`scanner.tag_digits`) of the admin's org. */
async function orgTags(supabase: ManagerSession["supabase"], orgId: string) {
  const org = unwrap(await supabase.from("org").select("slug, settings").eq("id", orgId).single());
  if (!org) throw new Error("Organisation unavailable");
  return { slug: org.slug, digits: (org.settings as OrgSettings).scanner.tag_digits };
}
export async function manageTags(_: ActionState, form: FormData): Promise<ActionState> {
  const result = await adminMutation(
    form,
    async ({ supabase, claims }, id) => {
      if (form.get("tag_id"))
        return unwrap(
          await supabase.rpc("admin_asset_tags", {
            p_client_action_id: id,
            p_tag_id: String(form.get("tag_id")),
            p_retire_reason: form.get("reactivate") ? undefined : String(form.get("reason") ?? ""),
          }),
        );
      const first = Number(form.get("first")),
        last = Number(form.get("last"));
      const org = await orgTags(supabase, claims.orgId);
      const problem = tagRangeProblem(first, last, org.digits);
      if (problem) throw new Error(problem);
      return unwrap(
        await supabase.rpc("admin_asset_tags", {
          p_client_action_id: id,
          p_tags: Array.from({ length: last - first + 1 }, (_, n) => {
            const code = normalizeTagCode(String(first + n), org.digits)!;
            return {
              code,
              qr: encode("TAG", { orgSlug: org.slug, code }, { tagDigits: org.digits }),
            };
          }),
        }),
      );
    },
    "Tag pool updated.",
  );
  revalidatePath("/admin/asset-tags");
  return result.error ? result : { ...result, nextActionId: randomUUID() };
}
export async function printTags(_: ActionState, form: FormData): Promise<ActionState> {
  const result = await adminMutation(
    form,
    async ({ supabase, claims }, id) => {
      const org = await orgTags(supabase, claims.orgId);
      const tags = unwrap(
        await supabase.from("asset_tag").select("code").neq("state", "retired").order("code"),
      );
      if (!tags?.length) throw new Error("Create tags first.");
      return enqueuePrintJob(supabase, id, {
        printerId: String(form.get("printer_id")),
        kind: "asset_tag_sheet",
        payloadType: "zpl",
        payload: assetTagSheet({
          orgSlug: org.slug,
          codes: tags.map((t) => t.code),
          tagDigits: org.digits,
        }),
      });
    },
    "Tag sheet queued.",
  );
  return result.error ? result : { ...result, nextActionId: randomUUID() };
}
