import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pairAgent } from "@/app/admin/print-agents/actions";
import { testPrint } from "@/app/admin/printers/actions";
import type { ActionState } from "@/lib/admin-action";
import { submitAdminForm } from "./action-form-state";

// Model the persisted action_log boundary, while exercising the real actions,
// adminMutation, withAction, enqueue helper and form-state transition.
const backend = vi.hoisted(() => {
  const completed = new Map<string, { completed_at: string; result: Record<string, string> }>();
  const writes: { name: string; id: string }[] = [];
  const control = { failNext: false };
  const client = {
    from: (table: string) => ({
      select: () => ({
        eq: (_column: string, id: string) => ({
          maybeSingle: async () => ({ data: completed.get(id) ?? null, error: null }),
          single: async () => ({
            data: table === "printer" ? { kind: "label_zpl" } : null,
            error: null,
          }),
        }),
      }),
    }),
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (control.failNext) {
        control.failNext = false;
        return { data: null, error: { message: "Try again" } };
      }
      const id = String(args.p_client_action_id);
      writes.push({ name, id });
      completed.set(id, { completed_at: new Date().toISOString(), result: {} });
      return {
        data:
          name === "admin_print_agent_pairing_code"
            ? [{ code: "ABCD2345", expires_at: "2026-10-27T00:00:00Z", active: true }]
            : { job_id: id },
        error: null,
      };
    },
  };
  return { completed, writes, control, client };
});
vi.mock("@/lib/auth", () => ({
  requireManager: async () => ({ supabase: backend.client }),
  ForbiddenError: class ForbiddenError extends Error {},
}));
vi.mock("next/navigation", () => ({ unstable_rethrow: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
beforeEach(() => {
  backend.completed.clear();
  backend.writes.length = 0;
  backend.control.failNext = false;
});

for (const [name, action, field] of [
  ["pairing", pairAgent, "agent_id"],
  ["test print", testPrint, "printer_id"],
] as const) {
  describe(name, () => {
    function form(id: string) {
      const f = new FormData();
      f.set("client_action_id", id);
      f.set(field, randomUUID());
      return f;
    }
    it("successive intentional submissions perform separate operations without reloading", async () => {
      const initial = randomUUID();
      const firstForm = form(initial);
      const first = await submitAdminForm(action, {}, firstForm);
      expect(first.error).toBeUndefined();
      expect(first.ok).toBeTruthy();
      expect(first.nextActionId).toBeTruthy();
      expect(first.nextActionId).not.toBe(initial);
      // A lost first response retries the original request, not the next operation.
      await submitAdminForm(action, {}, firstForm);
      expect(backend.writes).toHaveLength(1);
      const second = await submitAdminForm(action, first, form(first.nextActionId!));
      expect(second.error).toBeUndefined();
      expect(second.nextActionId).not.toBe(first.nextActionId);
      expect(backend.writes.map((w) => w.id)).toEqual([initial, first.nextActionId]);
    });
    it("an error after success preserves the new ID for its retry", async () => {
      const first = await submitAdminForm(action, {}, form(randomUUID()));
      const retryForm = form(first.nextActionId!);
      backend.control.failNext = true;
      const failed = await submitAdminForm(action, first, retryForm);
      expect(failed.error).toBe("Try again");
      expect(failed.nextActionId).toBe(first.nextActionId);
      expect(backend.writes).toHaveLength(1);
      const retried = await submitAdminForm(action, failed, retryForm);
      expect(retried.error).toBeUndefined();
      expect(retried.nextActionId).not.toBe(failed.nextActionId);
      expect(backend.writes.map((w) => w.id)).toEqual([expect.any(String), failed.nextActionId]);
    });
  });
}
it("validation failures before any success keep the original server action ID", async () => {
  const original = randomUUID();
  const form = new FormData();
  form.set("client_action_id", original);
  const failed: ActionState = await submitAdminForm(pairAgent, {}, form);
  expect(failed.error).toBe("Invalid agent.");
  expect(failed.nextActionId).toBeUndefined();
  expect(backend.writes).toEqual([]);
});
