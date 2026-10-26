import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { Database, Json } from "./types";
import { ActionInProgressError, withAction } from "./with-action";

// A fake PostgREST that implements action_begin/complete/abort over an in-memory log.
function fakeClient() {
  const log = new Map<string, { result: Json; done: boolean }>();
  const calls: string[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const fn = String(input).split("/rpc/")[1]?.split("?")[0] ?? "";
    calls.push(fn);
    const args = JSON.parse(String(init?.body ?? "{}")) as Record<string, Json>;
    const id = String(args.p_client_action_id);
    let body: Json = null;
    if (fn === "action_begin") {
      const row = log.get(id);
      if (!row) {
        log.set(id, { result: null, done: false });
        body = { status: "new" };
      } else {
        body = row.done ? { status: "done", result: row.result } : { status: "pending" };
      }
    } else if (fn === "action_complete") {
      log.set(id, { result: args.p_result ?? null, done: true });
    } else if (fn === "action_abort") {
      log.delete(id);
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const client = createClient<Database>("http://fake.local", "anon", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch },
  });
  return { client, log, calls };
}

describe("withAction", () => {
  it("replaying an action id returns the stored result without re-running", async () => {
    const { client } = fakeClient();
    const fn = vi.fn(async () => ({ number: "INT-0001" }));
    const first = await withAction(client, "act-00000001", fn, { action: "intake.save" });
    const replay = await withAction(client, "act-00000001", fn, { action: "intake.save" });
    expect(first).toEqual({ number: "INT-0001" });
    expect(replay).toEqual(first);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("releases the claim when the action throws so a retry runs", async () => {
    const { client, calls } = fakeClient();
    await expect(
      withAction(client, "act-00000002", () => Promise.reject(new Error("boom")), { action: "x" }),
    ).rejects.toThrow("boom");
    expect(calls).toContain("action_abort");
    await expect(withAction(client, "act-00000002", async () => 7, { action: "x" })).resolves.toBe(
      7,
    );
  });

  it("reports an in-flight duplicate as ActionInProgressError", async () => {
    const { client, log } = fakeClient();
    log.set("act-00000003", { result: null, done: false });
    await expect(
      withAction(client, "act-00000003", async () => 1, { action: "x" }),
    ).rejects.toBeInstanceOf(ActionInProgressError);
  });
});
