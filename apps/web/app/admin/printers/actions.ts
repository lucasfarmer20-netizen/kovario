"use server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { enqueuePrintJob } from "db";
import { toteTag } from "labels/zpl";
import { adminMutation, unwrap, type ActionState } from "@/lib/admin-action";
export async function savePrinter(_state: ActionState, form: FormData): Promise<ActionState> {
  const value = z
    .object({
      name: z.string().trim().min(1).max(80),
      agent_id: z.uuid(),
      kind: z.enum(["label_zpl", "receipt_pdf"]),
      address: z.string().trim().min(1).max(200),
      site_id: z.union([z.uuid(), z.literal("")]),
      printer_id: z.union([z.uuid(), z.literal("")]),
    })
    .safeParse(Object.fromEntries(form));
  if (!value.success) return { error: "Complete the printer configuration." };
  const v = value.data;
  const result = await adminMutation(
    form,
    async ({ supabase }, id) =>
      unwrap(
        await supabase.rpc("admin_save_printer", {
          p_client_action_id: id,
          p_name: v.name,
          p_agent_id: v.agent_id,
          p_kind: v.kind,
          p_address: v.address,
          p_site_id: v.site_id || undefined,
          p_printer_id: v.printer_id || undefined,
        }),
      ),
    "Printer saved.",
  );
  revalidatePath("/admin/printers");
  return result;
}
export async function testPrint(_state: ActionState, form: FormData): Promise<ActionState> {
  const id = z.uuid().safeParse(form.get("printer_id"));
  if (!id.success) return { error: "Invalid printer." };
  const result = await adminMutation(
    form,
    async ({ supabase }, actionId) => {
      const printer = unwrap(
        await supabase.from("printer").select("kind").eq("id", id.data).single(),
      );
      if (!printer) throw new Error("Printer missing");
      if (printer.kind === "receipt_pdf") {
        const url = z.url().safeParse(form.get("pdf_url"));
        if (!url.success || !url.data.startsWith("https://"))
          throw new Error("Enter a signed HTTPS PDF URL for the test receipt.");
        return enqueuePrintJob(supabase, actionId, {
          printerId: id.data,
          kind: "receipt",
          payloadType: "pdf_url",
          payload: url.data,
          source: { test: true },
        });
      }
      return enqueuePrintJob(supabase, actionId, {
        printerId: id.data,
        kind: "tote_tag",
        payloadType: "zpl",
        payload: toteTag({
          intakeNumber: "INT-0000",
          toteNo: 1,
          toteCount: 1,
          customer: "TEST PRINT - DO NOT USE",
          date: new Date().toISOString().slice(0, 10),
          lines: [],
        }),
        source: { test: true },
      });
    },
    "Test print queued. Check the printer and job status.",
  );
  return result.error ? result : { ...result, nextActionId: randomUUID() };
}
